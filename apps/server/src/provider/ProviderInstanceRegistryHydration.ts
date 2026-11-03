import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ProviderInstanceId,
  providerInstanceConfigEnabledFlag,
  resolveProviderInstanceEnabled,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  ServerSettings,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as Crypto from "effect/Crypto";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as Settings from "../serverSettings.ts";
import * as SecretResolver from "../secrets/SecretResolver.ts";
import { BUILT_IN_DRIVERS, type BuiltInDriversEnv } from "./builtInDrivers.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderInstanceRegistryMutator from "./ProviderInstanceRegistryMutator.ts";
import * as ProviderOrchestrationAdapterInfrastructure from "./ProviderOrchestrationAdapterInfrastructure.ts";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as ProviderHostLive from "./ProviderHostLive.ts";
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import type * as PortScanner from "../preview/PortScanner.ts";

type ProviderInstanceRegistryHydrationEnv =
  | Exclude<
      BuiltInDriversEnv,
      | ProviderOrchestrationAdapterInfrastructure.ProviderOrchestrationAdapterInfrastructure
      | AcpRegistrySupport.AcpRegistryCatalog
      | ProviderHost.ProviderHost
    >
  | Settings.ServerSettingsService
  | BackgroundPolicy.BackgroundPolicy
  | ServerConfig.ServerConfig
  | Path.Path
  | FileSystem.FileSystem
  // Secret provider reads.
  | Crypto.Crypto
  // The Claude runner counts its CLIs as running agents for port discovery.
  | PortScanner.PortDiscovery;

export const deriveProviderInstanceConfigMap = (
  settings: ServerSettings,
): ProviderInstanceConfigMap => {
  const merged: Record<string, ProviderInstanceConfig> = { ...settings.providerInstances };

  for (const driver of BUILT_IN_DRIVERS) {
    if (driver.metadata.hasDefaultInstance === false) continue;
    const instanceId = defaultInstanceIdForDriver(driver.driverKind);
    if (instanceId in merged) continue;
    merged[instanceId] = { driver: driver.driverKind };
  }

  // Probe project-enabled instances even if disabled machine-wide; project threads can still route to them.
  for (const overrides of Object.values(settings.projectSettingsOverrides)) {
    for (const [rawInstanceId, projectOverride] of Object.entries(
      overrides?.providerInstances ?? {},
    )) {
      if (projectOverride.enabled !== true) continue;
      const instanceId = rawInstanceId as ProviderInstanceId;
      const existing = merged[instanceId];
      if (existing === undefined || resolveProviderInstanceEnabled(existing)) continue;
      merged[instanceId] = {
        ...existing,
        enabled: true,
        ...(providerInstanceConfigEnabledFlag(existing.config) === false
          ? { config: { ...(existing.config as Record<string, unknown>), enabled: true } }
          : {}),
      };
    }
  }

  return merged as ProviderInstanceConfigMap;
};

export const DEV_REPLAY_INSTANCE_ID = ProviderInstanceId.make("devReplay");

/**
 * Dev servers run from source keep a free ACP agent that replays recorded turns, so UI checks
 * need no paid model. Bundled servers, such as desktop dev, have no agent script and skip it.
 */
export const seedDevReplayInstance = Effect.fn(
  "ProviderInstanceRegistryHydration.seedDevReplayInstance",
)(function* () {
  const config = yield* ServerConfig.ServerConfig;
  if (config.devUrl === undefined) return;
  const path = yield* Path.Path;
  const agentPath = yield* path.fromFileUrl(
    new URL("../../scripts/dev-replay-agent.ts", import.meta.url),
  );
  if (!(yield* (yield* FileSystem.FileSystem).exists(agentPath))) return;
  const commandPath = yield* HostProcess.ExecutablePath;
  const serverSettings = yield* Settings.ServerSettingsService;
  const existing = (yield* serverSettings.getSettings).providerInstances[DEV_REPLAY_INSTANCE_ID];
  const existingConfig = existing?.config as Record<string, unknown> | undefined;
  // Rewritten only when stale: the node and checkout paths can move.
  if (
    existingConfig?.commandPath === commandPath &&
    (existingConfig.commandArgs as ReadonlyArray<unknown> | undefined)?.[0] === agentPath
  ) {
    return;
  }
  // Keeps user edits, such as turning the provider off.
  const instance: ProviderInstanceConfig = {
    displayName: "Replay (dev)",
    ...existing,
    driver: ProviderDriverKind.make("acpRegistry"),
    config: { ...existingConfig, source: "local", commandPath, commandArgs: [agentPath] },
  };
  yield* serverSettings.updateProviderInstance({
    operation: "upsert",
    instanceId: DEV_REPLAY_INSTANCE_ID,
    instance,
  });
});

export const FP_A2A_INSTANCE_ID = ProviderInstanceId.make("flightplanA2a");
export const FP_AGENTSCOPE_INSTANCE_ID = ProviderInstanceId.make("flightplanAgentscope");

/**
 * Fork (flightplan): the "A2A" provider. `T3CODE_FP_A2A_AGENT` names the ACP bridge script
 * (integrations/flightplan-a2a/a2a-acp-agent.mjs), which answers prompts through A2A. Unset: no-op.
 * The bridge is an ordinary local ACP command, so the stock ACP adapter does the rest.
 */
export const seedFlightplanA2aInstance = Effect.fn(
  "ProviderInstanceRegistryHydration.seedFlightplanA2aInstance",
)(function* () {
  const agentPath = (yield* Config.String("T3CODE_FP_A2A_AGENT").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ))?.trim();
  if (agentPath === undefined || agentPath.length === 0) return;
  const fileSystem = yield* FileSystem.FileSystem;
  if (!(yield* fileSystem.exists(agentPath))) {
    return yield* Effect.logWarning("T3CODE_FP_A2A_AGENT points to a missing file", { agentPath });
  }
  const commandPath = yield* HostProcess.ExecutablePath;
  const serverSettings = yield* Settings.ServerSettingsService;
  const existing = (yield* serverSettings.getSettings).providerInstances[FP_A2A_INSTANCE_ID];
  const existingConfig = existing?.config as Record<string, unknown> | undefined;
  if (
    existingConfig?.commandPath === commandPath &&
    (existingConfig.commandArgs as ReadonlyArray<unknown> | undefined)?.[0] === agentPath
  ) {
    return;
  }
  // Keeps user edits, such as turning the provider off.
  const instance: ProviderInstanceConfig = {
    displayName: "Gandalf (A2A)",
    ...existing,
    driver: ProviderDriverKind.make("acpRegistry"),
    config: { ...existingConfig, source: "local", commandPath, commandArgs: [agentPath] },
  };
  yield* serverSettings.updateProviderInstance({
    operation: "upsert",
    instanceId: FP_A2A_INSTANCE_ID,
    instance,
  });
});

/**
 * Fork (flightplan): second local ACP instance. Same bridge, peer `agentscope`
 * on 127.0.0.1:9908. The instance environment is what the ACP driver puts on
 * the child process (`FP_A2A_AGENTS`). The model stays in fake mode until the
 * agent container is switched; this seed does not set that.
 */
export const seedFlightplanAgentscopeInstance = Effect.fn(
  "ProviderInstanceRegistryHydration.seedFlightplanAgentscopeInstance",
)(function* () {
  const agentPath = (yield* Config.String("T3CODE_FP_A2A_AGENT").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ))?.trim();
  if (agentPath === undefined || agentPath.length === 0) return;
  const fileSystem = yield* FileSystem.FileSystem;
  if (!(yield* fileSystem.exists(agentPath))) {
    return yield* Effect.logWarning("T3CODE_FP_A2A_AGENT points to a missing file", { agentPath });
  }
  const commandPath = yield* HostProcess.ExecutablePath;
  const serverSettings = yield* Settings.ServerSettingsService;
  const existing = (yield* serverSettings.getSettings).providerInstances[FP_AGENTSCOPE_INSTANCE_ID];
  const existingConfig = existing?.config as Record<string, unknown> | undefined;
  const peer = existing?.environment?.find((entry) => entry.name === "FP_A2A_AGENTS")?.value;
  if (
    existingConfig?.commandPath === commandPath &&
    (existingConfig.commandArgs as ReadonlyArray<unknown> | undefined)?.[0] === agentPath &&
    peer === "agentscope"
  ) {
    return;
  }
  const instance: ProviderInstanceConfig = {
    displayName: "AgentScope",
    ...existing,
    driver: ProviderDriverKind.make("acpRegistry"),
    environment: [
      { name: "FP_A2A_AGENTS", value: "agentscope", sensitive: false },
      { name: "FP_A2A_LABELS", value: '{"agentscope":"AgentScope"}', sensitive: false },
    ],
    config: { ...existingConfig, source: "local", commandPath, commandArgs: [agentPath] },
  };
  yield* serverSettings.updateProviderInstance({
    operation: "upsert",
    instanceId: FP_AGENTSCOPE_INSTANCE_ID,
    instance,
  });
});

const layerSettingsWatcher = (settingsChanges: Stream.Stream<ServerSettings>) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const mutator = yield* ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator;
      const serverSettings = yield* Settings.ServerSettingsService;
      yield* settingsChanges.pipe(
        Stream.runForEach(() =>
          // The subscription predates the seed read, so a queued change can be
          // older than the seed. A failed current read must leave the registry intact.
          serverSettings.getSettings.pipe(
            Effect.flatMap((current) =>
              mutator.reconcile(deriveProviderInstanceConfigMap(current)),
            ),
            Effect.catchCause((cause) =>
              Effect.logError("ProviderInstanceRegistry reconcile failed", cause),
            ),
          ),
        ),
        Effect.forkScoped,
      );
    }),
  );

export const layer: Layer.Layer<
  | ProviderInstanceRegistry.ProviderInstanceRegistry
  | ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator,
  never,
  ProviderInstanceRegistryHydrationEnv
> = Layer.unwrap(
  Effect.gen(function* () {
    const serverSettings = yield* Settings.ServerSettingsService;
    yield* seedDevReplayInstance().pipe(
      Effect.catchCause((cause) => Effect.logWarning("Dev replay agent unavailable", cause)),
    );
    yield* seedFlightplanA2aInstance().pipe(
      Effect.catchCause((cause) => Effect.logWarning("A2A agent unavailable", cause)),
    );
    yield* seedFlightplanAgentscopeInstance().pipe(
      Effect.catchCause((cause) => Effect.logWarning("AgentScope agent unavailable", cause)),
    );
    // Subscribe before the seed read so saves during registry construction are queued.
    const settingsChanges = yield* serverSettings.subscribeChanges;
    const initialSettings: ServerSettings | undefined = yield* serverSettings.getSettings.pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const initialConfigMap =
      initialSettings === undefined
        ? ({} as ProviderInstanceConfigMap)
        : deriveProviderInstanceConfigMap(initialSettings);

    const layerMutable = ProviderInstanceRegistry.layer({
      drivers: BUILT_IN_DRIVERS,
      configMap: initialConfigMap,
    }).pipe(
      Layer.provide(ProviderOrchestrationAdapterInfrastructure.layer),
      Layer.provide(AcpRegistrySupport.layerFromHost),
      Layer.provide(ProviderHostLive.layer),
      Layer.provide(SecretResolver.layer),
    );

    return layerSettingsWatcher(settingsChanges).pipe(Layer.provideMerge(layerMutable));
  }),
) as Layer.Layer<
  | ProviderInstanceRegistry.ProviderInstanceRegistry
  | ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator,
  never,
  ProviderInstanceRegistryHydrationEnv
>;
