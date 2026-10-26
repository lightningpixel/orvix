import type { Node } from "web-tree-sitter";

/**
 * Calls made through a channel name rather than a reference.
 *
 * `ipcMain.handle("config:get", getConfig)` and
 * `ipcRenderer.invoke("config:get")` are one call split across a process
 * boundary, and no syntactic resolver can see it: the caller names a string.
 * Matching the string on both sides recovers it. The match is weaker evidence
 * than a call, so these links are recorded apart from call edges and always
 * shown with their channel.
 */
export interface RawChannelSite {
  role: "listen" | "dispatch";
  channel: string;
  /** The handler's name, for a registration. */
  handler?: string;
  line: number;
  byte: number;
}

/** Methods that register a handler for a channel. */
const LISTEN = new Set(["on", "once", "addListener", "handle", "handleOnce", "subscribe"]);

/** Methods that send to a channel. */
const DISPATCH = new Set(["emit", "send", "invoke", "sendSync", "dispatch", "publish", "trigger"]);

/**
 * Channel names used by so many unrelated emitters that a match between two
 * of them says nothing: every Node stream emits "data", every socket "close".
 */
const TOO_COMMON = new Set([
  "data", "error", "end", "close", "message", "change", "click", "ready", "open", "finish",
  "connect", "connection", "disconnect", "load", "input", "submit", "exit", "drain", "readable",
  "request", "response", "timeout", "abort", "resize", "scroll", "keydown", "keyup", "mousedown",
  "mouseup", "focus", "blur", "update", "start", "stop", "done", "init", "destroy", "success",
]);

const ECMASCRIPT = new Set(["typescript", "tsx", "javascript"]);

/**
 * Reads a channel site from a member call, given the callee's name node, or
 * undefined when the call is not one: wrong method, no literal channel, a
 * channel too common to mean anything, or a registration whose handler is not
 * a plain name.
 */
export function channelSite(name: Node, call: Node, languageId: string): RawChannelSite | undefined {
  if (!ECMASCRIPT.has(languageId) || call.type !== "call_expression") return undefined;

  const role = LISTEN.has(name.text) ? "listen" : DISPATCH.has(name.text) ? "dispatch" : undefined;
  if (!role) return undefined;

  const args = call.childForFieldName("arguments")?.namedChildren.filter((n) => n !== null) ?? [];
  const channel = literal(args[0]);
  if (!channel || channel.length < 3 || TOO_COMMON.has(channel.toLowerCase())) return undefined;

  const site = { role, channel, line: name.startPosition.row + 1, byte: name.startIndex } as const;
  if (role === "dispatch") return site;

  const handler = args[1];
  return handler?.type === "identifier" ? { ...site, handler: handler.text } : undefined;
}

/** The text of a plain string literal, without interpolation. */
function literal(node: Node | undefined): string | undefined {
  if (!node || node.type !== "string") return undefined;
  const parts = node.namedChildren.filter((child) => child !== null);
  if (parts.length !== 1 || parts[0]!.type !== "string_fragment") return undefined;
  return parts[0]!.text;
}
