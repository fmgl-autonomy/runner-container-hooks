import { v4 as uuidv4 } from 'uuid'

export function getRunnerPodName(): string {
  const name = process.env.ACTIONS_RUNNER_POD_NAME
  if (!name) {
    throw new Error(
      "'ACTIONS_RUNNER_POD_NAME' env is required, please contact your self hosted runner administrator"
    )
  }
  return name
}

export function getJobPodName(): string {
  return `${getRunnerPodName().substring(
    0,
    MAX_POD_NAME_LENGTH - '-workflow'.length
  )}-workflow`
}

export function getStepPodName(): string {
  return `${getRunnerPodName().substring(
    0,
    MAX_POD_NAME_LENGTH - ('-step-'.length + STEP_POD_NAME_SUFFIX_LENGTH)
  )}-step-${uuidv4().substring(0, STEP_POD_NAME_SUFFIX_LENGTH)}`
}

export function getVolumeClaimName(): string {
  const name = process.env.ACTIONS_RUNNER_CLAIM_NAME
  if (!name) {
    return `${getRunnerPodName()}-work`
  }
  return name
}

export function getSecretName(): string {
  return `${getRunnerPodName().substring(
    0,
    MAX_POD_NAME_LENGTH - ('-secret-'.length + STEP_POD_NAME_SUFFIX_LENGTH)
  )}-secret-${uuidv4().substring(0, STEP_POD_NAME_SUFFIX_LENGTH)}`
}

export const MAX_POD_NAME_LENGTH = 63
export const STEP_POD_NAME_SUFFIX_LENGTH = 8
export const CONTAINER_EXTENSION_PREFIX = '$'
export const JOB_CONTAINER_NAME = 'job'
export const JOB_CONTAINER_EXTENSION_NAME = '$job'

export class RunnerInstanceLabel {
  private podName: string
  constructor() {
    this.podName = getRunnerPodName()
  }

  get key(): string {
    return 'runner-pod'
  }

  get value(): string {
    return this.podName
  }

  toString(): string {
    return `runner-pod=${this.podName}`
  }
}

export const K8S_CPU_REGEX = /^(\d+(\.\d{1,3})?|\d+m)$/
export const K8S_MEMORY_REGEX = /^(\d+(\.\d+)?([EPTGMK]i?)|(\d+))$/

/* These are values that can be provided on the runner container in the scale set. They're
intended to specify the default resources for the job/service containers as well as the max
values that the users can request in their workflows. */
export const ACTIONS_RUNNER_K8S_CPU_REQUEST_DEFAULT =
  'ACTIONS_RUNNER_K8S_CPU_REQUEST_DEFAULT'
export const ACTIONS_RUNNER_K8S_CPU_LIMIT_DEFAULT =
  'ACTIONS_RUNNER_K8S_CPU_LIMIT_DEFAULT'
export const ACTIONS_RUNNER_K8S_MEMORY_REQUEST_DEFAULT =
  'ACTIONS_RUNNER_K8S_MEMORY_REQUEST_DEFAULT'
export const ACTIONS_RUNNER_K8S_MEMORY_LIMIT_DEFAULT =
  'ACTIONS_RUNNER_K8S_MEMORY_LIMIT_DEFAULT'
export const ACTIONS_RUNNER_K8S_CPU_REQUEST_MAX =
  'ACTIONS_RUNNER_K8S_CPU_REQUEST_MAX'
export const ACTIONS_RUNNER_K8S_CPU_LIMIT_MAX =
  'ACTIONS_RUNNER_K8S_CPU_LIMIT_MAX'
export const ACTIONS_RUNNER_K8S_MEMORY_REQUEST_MAX =
  'ACTIONS_RUNNER_K8S_MEMORY_REQUEST_MAX'
export const ACTIONS_RUNNER_K8S_MEMORY_LIMIT_MAX =
  'ACTIONS_RUNNER_K8S_MEMORY_LIMIT_MAX'
export const ACTIONS_RUNNER_K8S_SKIP_COPY_EXTERNALS =
  'ACTIONS_RUNNER_K8S_SKIP_COPY_EXTERNALS'

/* These are the env variables that we will look for in the job containers container definition
and use them to override the runner defined resource requests and limits. */
export const ACTIONS_RUNNER_K8S_CPU_REQUEST = 'ACTIONS_RUNNER_CPU_REQUEST'
export const ACTIONS_RUNNER_K8S_CPU_LIMIT = 'ACTIONS_RUNNER_CPU_LIMIT'
export const ACTIONS_RUNNER_K8S_MEMORY_REQUEST = 'ACTIONS_RUNNER_MEMORY_REQUEST'
export const ACTIONS_RUNNER_K8S_MEMORY_LIMIT = 'ACTIONS_RUNNER_MEMORY_LIMIT'
