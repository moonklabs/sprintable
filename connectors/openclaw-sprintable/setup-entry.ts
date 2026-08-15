/**
 * Lightweight setup entry — loaded during onboarding, deferred channel startup, and
 * read-only status/SecretRef scans. Must NOT start clients, listeners, or transport
 * runtimes (per docs/plugins/sdk-channel-plugins.md's explicit warning) — this only
 * exports the plugin object itself, same as the main index.ts's `plugin` field, so
 * OpenClaw can answer "is sprintable configured?" without booting the SSE dial-out.
 */
import { defineSetupPluginEntry } from 'openclaw/plugin-sdk/channel-core'
import { sprintablePlugin } from './src/channel.js'

export default defineSetupPluginEntry(sprintablePlugin)
