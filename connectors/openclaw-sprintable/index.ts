/**
 * Sprintable Gateway channel plugin for OpenClaw — main entry point.
 *
 * Uses `defineChannelPluginEntry` (the current, documented entry helper — ground-truthed
 * against openclaw@2026.7.1-2's docs/plugins/sdk-channel-plugins.md walkthrough) instead of
 * exporting the ChannelPlugin object directly. `registerCliMetadata` is safe to run on every
 * CLI invocation (help text, status scans) without starting the SSE dial-out; the actual
 * listener only starts via `plugin.gateway.startAccount`, which OpenClaw calls once the
 * channel is configured and the full gateway runtime boots — never from CLI-metadata-only
 * paths. This is the trap S8's research doc flagged: don't load listeners from the setup
 * entry, only from full-runtime registration.
 */
import { defineChannelPluginEntry } from 'openclaw/plugin-sdk/channel-core'
import { sprintablePlugin, CHANNEL_ID } from './src/channel.js'

export default defineChannelPluginEntry({
  id: CHANNEL_ID,
  name: 'Sprintable',
  description: 'Sprintable channel — real-time Agent Gateway events (SSE dial-out) + reply.',
  plugin: sprintablePlugin,
  registerCliMetadata(api) {
    api.registerCli(
      ({ program }) => {
        program.command('sprintable').description('Sprintable channel management')
      },
      {
        descriptors: [
          { name: 'sprintable', description: 'Sprintable channel management', hasSubcommands: false },
        ],
      },
    )
  },
})
