import * as core from '@actions/core'
import * as io from '@actions/io'
import * as k8s from '@kubernetes/client-node'
import {
  JobContainerInfo,
  ContextPorts,
  PrepareJobArgs,
  writeToResponseFile
} from 'hooklib'
import path from 'path'
import {
  containerPorts,
  createPod,
  isPodContainerAlpine,
  prunePods,
  waitForPodPhases,
  getPrepareJobTimeoutSeconds
} from '../k8s'
import {
  containerVolumes,
  DEFAULT_CONTAINER_ENTRY_POINT,
  DEFAULT_CONTAINER_ENTRY_POINT_ARGS,
  generateContainerName,
  mergeContainerWithOptions,
  readExtensionFromFile,
  PodPhase,
  fixArgs
} from '../k8s/utils'
import {
  CONTAINER_EXTENSION_PREFIX,
  JOB_CONTAINER_NAME,
  ACTIONS_RUNNER_K8S_CPU_REQUEST_DEFAULT,
  ACTIONS_RUNNER_K8S_CPU_LIMIT_DEFAULT,
  ACTIONS_RUNNER_K8S_MEMORY_REQUEST_DEFAULT,
  ACTIONS_RUNNER_K8S_MEMORY_LIMIT_DEFAULT,
  ACTIONS_RUNNER_K8S_CPU_REQUEST_MAX,
  ACTIONS_RUNNER_K8S_CPU_LIMIT_MAX,
  ACTIONS_RUNNER_K8S_MEMORY_REQUEST_MAX,
  ACTIONS_RUNNER_K8S_MEMORY_LIMIT_MAX,
  ACTIONS_RUNNER_K8S_CPU_REQUEST,
  ACTIONS_RUNNER_K8S_CPU_LIMIT,
  ACTIONS_RUNNER_K8S_MEMORY_REQUEST,
  ACTIONS_RUNNER_K8S_MEMORY_LIMIT,
  ACTIONS_RUNNER_K8S_SKIP_COPY_EXTERNALS,
  K8S_CPU_REGEX,
  K8S_MEMORY_REGEX
} from './constants'

export async function prepareJob(
  args: PrepareJobArgs,
  responseFile
): Promise<void> {
  if (!args.container) {
    throw new Error('Job Container is required.')
  }

  await prunePods()

  const extension = readExtensionFromFile()

  if (process.env[ACTIONS_RUNNER_K8S_SKIP_COPY_EXTERNALS] !== 'true') {
    await copyExternalsToRoot()
  }

  let container: k8s.V1Container | undefined = undefined
  if (args.container?.image) {
    core.debug(`Using image '${args.container.image}' for job image`)
    container = createContainerSpec(
      args.container,
      JOB_CONTAINER_NAME,
      true,
      extension
    )
  }

  let services: k8s.V1Container[] = []
  if (args.services?.length) {
    services = args.services.map(service => {
      core.debug(`Adding service '${service.image}' to pod definition`)
      return createContainerSpec(
        service,
        generateContainerName(service.image),
        false,
        extension
      )
    })
  }

  if (!container && !services?.length) {
    throw new Error('No containers exist, skipping hook invocation')
  }

  let createdPod: k8s.V1Pod | undefined = undefined
  try {
    createdPod = await createPod(
      container,
      services,
      args.container.registry,
      extension
    )
  } catch (err) {
    await prunePods()
    core.debug(`createPod failed: ${JSON.stringify(err)}`)
    const message = (err as any)?.response?.body?.message || err
    throw new Error(`failed to create job pod: ${message}`)
  }

  if (!createdPod?.metadata?.name) {
    throw new Error('created pod should have metadata.name')
  }
  core.debug(
    `Job pod created, waiting for it to come online ${createdPod?.metadata?.name}`
  )

  try {
    await waitForPodPhases(
      createdPod.metadata.name,
      new Set([PodPhase.RUNNING]),
      new Set([PodPhase.PENDING]),
      getPrepareJobTimeoutSeconds()
    )
  } catch (err) {
    await prunePods()
    throw new Error(`pod failed to come online with error: ${err}`)
  }

  core.debug('Job pod is ready for traffic')

  let isAlpine = false
  try {
    isAlpine = await isPodContainerAlpine(
      createdPod.metadata.name,
      JOB_CONTAINER_NAME
    )
  } catch (err) {
    core.debug(
      `Failed to determine if the pod is alpine: ${JSON.stringify(err)}`
    )
    const message = (err as any)?.response?.body?.message || err
    throw new Error(`failed to determine if the pod is alpine: ${message}`)
  }
  core.debug(`Setting isAlpine to ${isAlpine}`)
  generateResponseFile(responseFile, args, createdPod, isAlpine)
}

function generateResponseFile(
  responseFile: string,
  args: PrepareJobArgs,
  appPod: k8s.V1Pod,
  isAlpine
): void {
  if (!appPod.metadata?.name) {
    throw new Error('app pod must have metadata.name specified')
  }
  const response = {
    state: {
      jobPod: appPod.metadata.name
    },
    context: {},
    isAlpine
  }

  const mainContainer = appPod.spec?.containers?.find(
    c => c.name === JOB_CONTAINER_NAME
  )
  if (mainContainer) {
    const mainContainerContextPorts: ContextPorts = {}
    if (mainContainer?.ports) {
      for (const port of mainContainer.ports) {
        mainContainerContextPorts[port.containerPort] =
          mainContainerContextPorts.hostPort
      }
    }

    response.context['container'] = {
      image: mainContainer.image,
      ports: mainContainerContextPorts
    }
  }

  if (args.services?.length) {
    const serviceContainerNames =
      args.services?.map(s => generateContainerName(s.image)) || []

    response.context['services'] = appPod?.spec?.containers
      ?.filter(c => serviceContainerNames.includes(c.name))
      .map(c => {
        const ctxPorts: ContextPorts = {}
        if (c.ports?.length) {
          for (const port of c.ports) {
            ctxPorts[port.containerPort] = port.hostPort
          }
        }

        return {
          image: c.image,
          ports: ctxPorts
        }
      })
  }

  writeToResponseFile(responseFile, JSON.stringify(response))
}

async function copyExternalsToRoot(): Promise<void> {
  const workspace = process.env['RUNNER_WORKSPACE']
  if (workspace) {
    await io.cp(
      path.join(workspace, '../../externals'),
      path.join(workspace, '../externals'),
      { force: true, recursive: true, copySourceDirectory: false }
    )
  }
}

export function createContainerSpec(
  container: JobContainerInfo,
  name: string,
  jobContainer = false,
  extension?: k8s.V1PodTemplateSpec
): k8s.V1Container {
  if (!container.entryPoint && jobContainer) {
    container.entryPoint = DEFAULT_CONTAINER_ENTRY_POINT
    container.entryPointArgs = DEFAULT_CONTAINER_ENTRY_POINT_ARGS
  }

  const podContainer = {
    name,
    image: container.image,
    ports: containerPorts(container)
  } as k8s.V1Container
  if (container.workingDirectory) {
    podContainer.workingDir = container.workingDirectory
  }

  if (container.entryPoint) {
    podContainer.command = [container.entryPoint]
  }

  if (container.entryPointArgs?.length > 0) {
    podContainer.args = fixArgs(container.entryPointArgs)
  }

  podContainer.env = []
  for (const [key, value] of Object.entries(
    container['environmentVariables']
  )) {
    if (value && key !== 'HOME') {
      podContainer.env.push({ name: key, value: value as string })
    }
  }

  podContainer.volumeMounts = containerVolumes(
    container.userMountVolumes,
    jobContainer
  )

  if (extension) {
    const from = extension.spec?.containers?.find(
      c => c.name === CONTAINER_EXTENSION_PREFIX + name
    )

    if (from) {
      mergeContainerWithOptions(podContainer, from)
    }
  }

  applyResourceLimitsAndRequests(podContainer, container.environmentVariables)

  return podContainer
}

/**
 * Apply any resource limits and requests to the pod container that are defined in the
 * workflow or the runner container defaults and ensure the resource limits and requests
 * are within the bounds defined by the runner. If there were any values defined in the
 * extensions file, they will be overridden by the values defined in the workflow, but
 * will override the runner container defaults. Values defined in the extensions file
 * will also need to be within the bounds defined by the runner max values (if provided).
 *
 * When applying the resource limits and requests, the order of precedence is:
 * 1. Values defined in the workflow
 * 2. Values defined in the extensions file
 * 3. Values defined in the runner container defaults (defaults used in the absence of any other values)
 * 4. Nothing is applied if no values are provided
 */
const applyResourceLimitsAndRequests = (
  podContainer: k8s.V1Container,
  environmentVariables: { [key: string]: string }
) => {
  const runnerDefaults = getRunnerDefinedValues()
  const workflowDefinedValues = getWorkflowDefinedValues(environmentVariables)

  const cpuRequest = getResourceValue(
    workflowDefinedValues.cpuRequest,
    runnerDefaults.cpuRequestDefault,
    runnerDefaults.cpuRequestMax,
    podContainer.resources?.requests?.cpu,
    'CPU request'
  )
  const cpuLimit = getResourceValue(
    workflowDefinedValues.cpuLimit,
    runnerDefaults.cpuLimitDefault,
    runnerDefaults.cpuLimitMax,
    podContainer.resources?.limits?.cpu,
    'CPU limit'
  )
  const memoryRequest = getResourceValue(
    workflowDefinedValues.memoryRequest,
    runnerDefaults.memoryRequestDefault,
    runnerDefaults.memoryRequestMax,
    podContainer.resources?.requests?.memory,
    'Memory request'
  )
  const memoryLimit = getResourceValue(
    workflowDefinedValues.memoryLimit,
    runnerDefaults.memoryLimitDefault,
    runnerDefaults.memoryLimitMax,
    podContainer.resources?.limits?.memory,
    'Memory limit'
  )

  /*
  Ensure that the resource values are within the runner defined max values (if max values are provided)
  */
  if (
    cpuRequest &&
    runnerDefaults.cpuRequestMax &&
    !isCpuValueInBounds(cpuRequest, runnerDefaults.cpuRequestMax)
  ) {
    throw new Error(
      `CPU request value is out of bounds. Value provided: ${cpuRequest}, max value: ${runnerDefaults.cpuRequestMax}`
    )
  }
  if (
    cpuLimit &&
    runnerDefaults.cpuLimitMax &&
    !isCpuValueInBounds(cpuLimit, runnerDefaults.cpuLimitMax)
  ) {
    throw new Error(
      `CPU limit value is out of bounds. Value provided: ${cpuLimit}, max value: ${runnerDefaults.cpuLimitMax}`
    )
  }
  if (
    memoryRequest &&
    runnerDefaults.memoryRequestMax &&
    !isMemoryValueInBounds(memoryRequest, runnerDefaults.memoryRequestMax)
  ) {
    throw new Error(
      `Memory request value is out of bounds. Value provided: ${memoryRequest}, max value: ${runnerDefaults.memoryRequestMax}`
    )
  }
  if (
    memoryLimit &&
    runnerDefaults.memoryLimitMax &&
    !isMemoryValueInBounds(memoryLimit, runnerDefaults.memoryLimitMax)
  ) {
    throw new Error(
      `Memory limit value is out of bounds. Value provided: ${memoryLimit}, max value: ${runnerDefaults.memoryLimitMax}`
    )
  }

  podContainer.resources = {
    limits: {
      ...(cpuLimit ? { cpu: cpuLimit } : {}),
      ...(memoryLimit ? { memory: memoryLimit } : {})
    },
    requests: {
      ...(cpuRequest ? { cpu: cpuRequest } : {}),
      ...(memoryRequest ? { memory: memoryRequest } : {})
    }
  }
}

/**
 * If there's a value defined in the workflow, but no max value is defined in the runner container values, then log a warning
 * and use the extension files value or the runner default value (if neither of those is defined, the value will be undefined).
 * This way workflows are prevented from setting values if the runner does not have guardrails in place.
 */
const getResourceValue = (
  workflowDefinedValue: string | undefined,
  runnerDefaultValue: string | undefined,
  runnerMaxValue: string | undefined,
  extensionValue: string | undefined,
  resource: string
): string | undefined => {
  if (workflowDefinedValue && !runnerMaxValue) {
    core.warning(
      `${resource} value provided in the workflow, but no max value is defined in the runner container values. Ignoring the workflow value.` +
        'Please contact your self hosted runner administrator'
    )
    return extensionValue || runnerDefaultValue
  }
  return workflowDefinedValue || extensionValue || runnerDefaultValue
}

interface DefaultResourceValues {
  cpuRequestDefault: string | undefined
  cpuLimitDefault: string | undefined
  memoryRequestDefault: string | undefined
  memoryLimitDefault: string | undefined
  cpuRequestMax: string | undefined
  cpuLimitMax: string | undefined
  memoryRequestMax: string | undefined
  memoryLimitMax: string | undefined
}

/**
 * Get the values defined in the scaleset spec for the default resources and the max resources.
 */
const getRunnerDefinedValues = (): DefaultResourceValues => {
  const cpuKeys = {
    cpuRequestDefault: ACTIONS_RUNNER_K8S_CPU_REQUEST_DEFAULT,
    cpuLimitDefault: ACTIONS_RUNNER_K8S_CPU_LIMIT_DEFAULT,
    cpuRequestMax: ACTIONS_RUNNER_K8S_CPU_REQUEST_MAX,
    cpuLimitMax: ACTIONS_RUNNER_K8S_CPU_LIMIT_MAX
  }
  const memoryKeys = {
    memoryRequestDefault: ACTIONS_RUNNER_K8S_MEMORY_REQUEST_DEFAULT,
    memoryLimitDefault: ACTIONS_RUNNER_K8S_MEMORY_LIMIT_DEFAULT,
    memoryRequestMax: ACTIONS_RUNNER_K8S_MEMORY_REQUEST_MAX,
    memoryLimitMax: ACTIONS_RUNNER_K8S_MEMORY_LIMIT_MAX
  }

  const runnerDefinedValues = {}

  for (const [key, value] of Object.entries(cpuKeys)) {
    const runnerDefinedValue = process.env[value]
    if (runnerDefinedValue && !K8S_CPU_REGEX.test(runnerDefinedValue)) {
      throw new Error(
        `Runner defined value for ${key} is malformed. Value: ${runnerDefinedValue}`
      )
    }
    runnerDefinedValues[key] = runnerDefinedValue
  }

  for (const [key, value] of Object.entries(memoryKeys)) {
    const runnerDefinedValue = process.env[value]
    if (runnerDefinedValue && !K8S_MEMORY_REGEX.test(runnerDefinedValue)) {
      throw new Error(
        `Runner defined value for ${key} is malformed. Value: ${runnerDefinedValue}`
      )
    }
    runnerDefinedValues[key] = runnerDefinedValue
  }

  return runnerDefinedValues as DefaultResourceValues
}

const getWorkflowDefinedValues = (environmentVariables: {
  [key: string]: string
}) => {
  const cpuRequest = environmentVariables[ACTIONS_RUNNER_K8S_CPU_REQUEST]
  const cpuLimit = environmentVariables[ACTIONS_RUNNER_K8S_CPU_LIMIT]
  const memoryRequest = environmentVariables[ACTIONS_RUNNER_K8S_MEMORY_REQUEST]
  const memoryLimit = environmentVariables[ACTIONS_RUNNER_K8S_MEMORY_LIMIT]

  if (cpuRequest && !K8S_CPU_REGEX.test(cpuRequest)) {
    throw new Error(
      `Workflow defined value for ${ACTIONS_RUNNER_K8S_CPU_REQUEST} is malformed. Value provided: ${cpuRequest}`
    )
  }
  if (cpuLimit && !K8S_CPU_REGEX.test(cpuLimit)) {
    throw new Error(
      `Workflow defined value for ${ACTIONS_RUNNER_K8S_CPU_LIMIT} is malformed. Value provided: ${cpuLimit}`
    )
  }
  if (memoryRequest && !K8S_MEMORY_REGEX.test(memoryRequest)) {
    throw new Error(
      `Workflow defined value for ${ACTIONS_RUNNER_K8S_MEMORY_REQUEST} is malformed. Value provided: ${memoryRequest}`
    )
  }
  if (memoryLimit && !K8S_MEMORY_REGEX.test(memoryLimit)) {
    throw new Error(
      `Workflow defined value for ${ACTIONS_RUNNER_K8S_MEMORY_LIMIT} is malformed. Value provided: ${memoryLimit}`
    )
  }

  return {
    cpuRequest,
    cpuLimit,
    memoryRequest,
    memoryLimit
  }
}

/**
 * Convert cpu values to be millicores for comparison.
 */
const toMilliNumber = (value: string) =>
  value.endsWith('m') ? Number(value.replace(/\D/g, '')) : Number(value) * 1000

const prefix: { [key: string]: number } = {
  k: 1000,
  M: 1000 ** 2,
  G: 1000 ** 3,
  T: 1000 ** 4,
  P: 1000 ** 5,
  E: 1000 ** 6,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6
}

/**
 * Convert memory values to be bytes for comparison.
 */
const toMemNumber = (value: string): number => {
  const hasUnits = value.match(/^([0-9]+)([A-Za-z]{1,2})$/)

  return hasUnits
    ? parseInt(hasUnits[1], 10) * prefix[hasUnits[2]]
    : parseInt(value, 10)
}

const isCpuValueInBounds = (value: string, max: string): boolean =>
  toMilliNumber(value) <= toMilliNumber(max)

const isMemoryValueInBounds = (value: string, max: string): boolean =>
  toMemNumber(value) <= toMemNumber(max)
