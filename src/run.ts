import * as core from '@actions/core'
import * as github from '@actions/github'
import * as exec from '@actions/exec'
import * as git from './git'
import {detect} from 'detect-package-manager'

export async function run(): Promise<void> {
  core.info('Starting...')

  const baseBranch = core.getInput('base-branch') || 'main'
  const treshold = parseInt(core.getInput('treshold')) || 300 // ms
  const customCommand = core.getInput('custom-command') || undefined
  const extended = core.getInput('extended') === 'true'

  const shouldLeaveComment = core.getInput('leave-comment') === 'true'
  const githubToken: string | undefined =
    core.getInput('github-token') || undefined

  try {
    const bin = (await exec.getExecOutput('yarn bin')).stdout.trim()
    const tsc = `${bin}/tsc`
    core.debug(`tsc: ${tsc}, bin: ${bin}`)

    const command = customCommand
      ? customCommand
      : `${tsc} ${
          extended ? '--extendedDiagnostics' : '--diagnostics'
        } --incremental false`

    const newResult = await exec.getExecOutput(command)
    if (!newResult.stdout.includes('Check time') && customCommand) {
      throw new Error(
        `Custom command '${customCommand}' does not output '--extendedDiagnostics' or '--diagnostics' flag. Please add it to your command.`
      )
    }

    await git.fetch(githubToken, baseBranch)
    await git.cmd([], 'checkout', baseBranch)

    const packageManager = await detect()
    core.debug(`package manager: ${packageManager}`)
    core.debug(`installing dependencies with ${packageManager}`)
    if (packageManager === 'yarn') {
      await exec.exec('yarn')
    } else if (packageManager === 'npm') {
      await exec.exec('npm', ['install'])
    } else if (packageManager === 'pnpm') {
      await exec.exec('pnpm', ['install'])
    } else {
      throw new Error(
        `Package manager ${packageManager} is not supported. Please use yarn, npm or pnpm`
      )
    }

    const previousResult = await exec.getExecOutput(command)

    const diff = compareDiagnostics(
      previousResult.stdout,
      newResult.stdout,
      treshold
    )

    core.info(diff)
    if (shouldLeaveComment) {
      if (!githubToken) {
        throw new Error(
          `'github-token' is not set. Please give API token to send commit comment`
        )
      }
      await leaveComment(diff, githubToken)
    }

    core.info('Finished!')
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}

const getCurrentRepoMetadata = () => {
  const {repo, owner} = github.context.repo
  const serverUrl = git.getServerUrl(
    github.context.payload.repository?.html_url
  )
  return {
    name: repo,
    owner: {
      login: owner
    },

    html_url: `${serverUrl}/${owner}/${repo}`
  }
}

const getCurrentPRID = () => {
  const pr = github.context.payload.pull_request
  if (!pr) {
    throw new Error('This action can only be run in PR context')
  }
  return pr.number
}

const leaveComment = async (body: string, token: string) => {
  const repoMetadata = getCurrentRepoMetadata()
  const client = github.getOctokit(token)
  const {data: comments} = await client.rest.issues.listComments({
    owner: repoMetadata.owner.login,
    repo: repoMetadata.name,
    issue_number: getCurrentPRID()
  })

  const previousComment = comments.find(c => {
    return c.body?.includes('Diagnostics Comparison')
  })

  if (previousComment) {
    core.debug(`Updating comment:\n${body}`)
    await client.rest.issues.updateComment({
      owner: repoMetadata.owner.login,
      repo: repoMetadata.name,
      comment_id: previousComment.id,
      issue_number: getCurrentPRID(),
      body
    })
    return previousComment
  }

  core.debug(`Sending new comment:\n${body}`)
  const {data: createCommentResponse} = await client.rest.issues.createComment({
    owner: repoMetadata.owner.login,
    repo: repoMetadata.name,
    issue_number: getCurrentPRID(),
    body
  })

  return createCommentResponse
}

type Diagnostics = {
  [key: string]: {
    value: number
    unit: 's' | '' | 'K'
  }
}

function parseDiagnostics(input: string): Diagnostics {
  const diagnostics: Diagnostics = {}
  const lines = input.split('\n')

  for (const line of lines) {
    const parts = line.split(':')
    if (parts.length === 2) {
      const key = parts[0].trim()
      const value = parts[1].trim()
      if (value.endsWith('s')) {
        diagnostics[key] = {
          value: parseFloat(value.replace('s', '')),
          unit: 's'
        }
      } else if (value.endsWith('K')) {
        diagnostics[key] = {
          value: parseInt(value.replace('K', '')),
          unit: 'K'
        }
      } else {
        diagnostics[key] = {
          value: parseInt(value),
          unit: ''
        }
      }
    }
  }

  return diagnostics
}

function compareDiagnostics(
  prev: string,
  current: string,
  threshold: number
): string {
  const previousDiagnostics = parseDiagnostics(prev)
  const currentDiagnostics = parseDiagnostics(current)
  core.debug(JSON.stringify(currentDiagnostics))

  let markdown = '## Diagnostics Comparison:\n\n'
  markdown += `<details><summary>Click to expand</summary>\n\n`
  markdown += '| Metric | Previous | New | Status |\n'
  markdown += '| --- | --- | --- | --- |\n'

  for (const key in currentDiagnostics) {
    core.debug(`key: ${key}`)
    const prevValue = previousDiagnostics[key] || 0
    const currentValue = currentDiagnostics[key] || 0

    const diff = currentValue.value - prevValue.value

    let diffPercentage =
      currentValue.value !== 0 ? (diff / currentValue.value) * 100 : 0

    if (isNaN(diffPercentage)) diffPercentage = 0

    const shouldApplyThreshold = key.toLowerCase().includes('time')
    const isWithinThreshold = Math.abs(diff) * 1000 <= threshold

    let status = ''
    if (diff === 0) {
      status = '±'
    } else if (shouldApplyThreshold && isWithinThreshold) {
      status = '±'
    } else {
      status = diff > 0 ? '▲' : '▼'
    }

    markdown += `| ${key} | ${prevValue.value}${prevValue.unit} | ${
      currentValue.value
    }${currentValue.unit} | ${status} (${
      diffPercentage > 0 ? '+' : ''
    }${diffPercentage.toFixed(2)}%) |\n`
  }

  markdown += '</details>\n\n'

  return markdown
}

// ref: https://github.com/microsoft/TypeScript/issues/52867
const Database = () => ({
  query: (query: string) => {
    if (!query) return
    return {
      get: (args: Record<string, number>) => {
        if (!args) return

        return {
          last_processed: '2019-01-01',
          last_known_update: '2019-01-01'
        }
      }
    }
  }
})

type oneToNine = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
type zeroToNine = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
export type YYYY =
  | `19${zeroToNine}${zeroToNine}`
  | `20${zeroToNine}${zeroToNine}`
type MM = `0${oneToNine}` | `1${0 | 1 | 2}`
type DD = `${0}${oneToNine}` | `${1 | 2}${zeroToNine}` | `3${0 | 1}`
export type FullDateString = `${YYYY}-${MM}-${DD}`

export const ensureSubmissionsAreUptodate = async (cik: number) => {
  const db = Database()
  const processedDatesQuery = db.query(
    `SELECT last_processed, last_known_update FROM edgar_submissions WHERE cik=$cik`
  )
  let last_processed: FullDateString | null = null
  let last_known_update: FullDateString | null = null
  const result = processedDatesQuery?.get({$cik: cik})

  if (result) {
    last_processed = result?.last_processed as FullDateString // this is the problem
    last_known_update = result?.last_known_update as FullDateString // and this
    return {last_processed, last_known_update}
  }

  return {
    last_processed: null,
    last_known_update:
      last_known_update || new Date().toISOString().slice(0, 10)
  }
}
