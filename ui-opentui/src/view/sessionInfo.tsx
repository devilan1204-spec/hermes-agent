/**
 * SessionInfoProvider — exposes the live `SessionInfo` (store `state.info`) to
 * deep view nodes WITHOUT threading the store through every layer (same pattern
 * as dimensions.tsx). First consumer: the file-tool renderer, which relativizes
 * paths against the session `cwd` (Epic 2.3). The fallback accessor (no
 * provider, e.g. a bare component test) is an empty info — consumers must treat
 * every field as optional anyway.
 */
import { type Accessor, createContext, type JSX, useContext } from 'solid-js'

import type { SessionInfo } from '../logic/store.ts'

const Ctx = createContext<Accessor<SessionInfo>>()
const EMPTY: SessionInfo = {}
const EMPTY_INFO: Accessor<SessionInfo> = () => EMPTY

export function SessionInfoProvider(props: { info: Accessor<SessionInfo>; children: JSX.Element }) {
  return <Ctx.Provider value={props.info}>{props.children}</Ctx.Provider>
}

/** The live session info accessor (empty info when no provider is mounted). */
export function useSessionInfo(): Accessor<SessionInfo> {
  return useContext(Ctx) ?? EMPTY_INFO
}
