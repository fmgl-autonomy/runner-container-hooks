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
import { mergeDeepRight } from 'ramda'
import { exec } from 'child_process'

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
    const from =
      extension.spec?.containers?.find(
        c => c.name === CONTAINER_EXTENSION_PREFIX + name
      ) || {}

    mergeContainerWithOptions(podContainer, from)
  }

  /* Workflow defined overrides applied last, for highest precedence */
  const finalSpec = applyWorkflowDefinedResourceOverrides(
    podContainer,
    container.environmentVariables
  )

  return finalSpec
}

/**
 * Apply resource overrides defined in the workflow to the container spec.
 */
const applyWorkflowDefinedResourceOverrides = (
  podContainer: k8s.V1Container,
  environmentVariables: { [key: string]: string }
) => {
  const runnerDefaults = getRunnerDefinedValues()
  const workflowDefinedValues = getWorkflowDefinedValues(environmentVariables)

  const cpuRequest =
    workflowDefinedValues.cpuRequest || runnerDefaults.cpuRequestDefault
  const cpuLimit =
    workflowDefinedValues.cpuLimit || runnerDefaults.cpuLimitDefault

  const memoryRequest =
    workflowDefinedValues.memoryRequest || runnerDefaults.memoryRequestDefault
  const memoryLimit =
    workflowDefinedValues.memoryLimit || runnerDefaults.memoryLimitDefault

  // TODO: Validate that the new values are within the max values defined in the runner

  const resources: Partial<k8s.V1Container> = {
    resources: {
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

  return mergeDeepRight(podContainer, resources)
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

  const runnerDefinedValues: Partial<DefaultResourceValues> = {}

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

  if (!isDefaultResourceValue(runnerDefinedValues)) {
    throw new Error(
      `Runner defined values are malformed. Values provided: ${JSON.stringify(
        runnerDefinedValues
      )}`
    )
  }

  return runnerDefinedValues
}

const isDefaultResourceValue = (
  value: Partial<DefaultResourceValues> | DefaultResourceValues
): value is DefaultResourceValues => {
  const schema: Record<keyof DefaultResourceValues, string> = {
    cpuRequestDefault: '',
    cpuLimitDefault: '',
    memoryRequestDefault: '',
    memoryLimitDefault: '',
    cpuRequestMax: '',
    cpuLimitMax: '',
    memoryRequestMax: '',
    memoryLimitMax: ''
  }

  return Object.keys(schema).every(
    key => key in value && ['string', 'undefined'].includes(typeof value[key])
  )
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
