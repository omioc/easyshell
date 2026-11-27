/**
 * Shell injection wrapper.
 *
 * Some facts can only be asked of "the machine the user is on right now", and
 * the only way to ask is to type into the interactive shell. The probe is meant
 * to be invisible, which puts two demands on that line:
 *
 * 1. The shell must not keep it. It is written with a leading space — the
 *    convention every shell that has an ignore-space option understands — and
 *    it removes its own history entry afterwards. It only does so after
 *    checking that the last entry really is this line: a shell that never
 *    recorded it would otherwise delete the user's previous command.
 * 2. The shell repaints its prompt once the line is done. That repaint is not
 *    output — the prompt the user is looking at was already on screen — so the
 *    manager drains it instead of printing it a second time.
 */

const ANSI_ESCAPE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Drops CSI/OSC escape sequences, which the shell interleaves with its prompt. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, '');
}

/** A prompt tail, as far as a terminal-less process can tell. */
export function looksLikePromptTail(text: string): boolean {
  return /(?:[$#%>]\s*|[\w.@~:/\\-]+\s?[>$#%])\s*$/.test(stripAnsi(text));
}

/**
 * A prompt that is waiting for an answer only a person can give.
 *
 * `ssh`, `scp`, `su`, `sudo` and `passwd` all read their answer from the same
 * tty the app types on, and none of them echoes what is typed. So a line the
 * app sends here is not noise on the user's screen — it *is* the answer, and
 * the login that follows fails with a password error nobody can explain.
 *
 * Matched against the last line on screen: every one of these prompts ends in
 * `:` or `?` and names what it wants.
 */
const CREDENTIAL_PROMPT =
  /(?:password|passphrase|passcode|verification code|one[- ]time|otp|continue connecting|yes\/no|fingerprint|token)[^\r\n]*[:?]\s*$/i;

/** True when the shell is waiting for a password, a passphrase or a `yes/no`. */
export function looksLikeCredentialPrompt(text: string): boolean {
  const line = promptOnScreen(text);
  return line.length > 0 && CREDENTIAL_PROMPT.test(line);
}

/**
 * A prompt that is asking for a password, not for a confirmation.
 *
 * `Continue connecting (yes/no)?` and a host-key fingerprint are answered with
 * a word that is not a password and must never be remembered as one, and a key
 * passphrase belongs to a key rather than to `user@host` — so the question here
 * is the narrow one: is the shell asking for a password?
 */
const PASSWORD_PROMPT = /(?:^|[^\w])password[^:\r\n]*[:?]\s*$/i;

export function looksLikePasswordPrompt(text: string): boolean {
  const line = promptOnScreen(text);
  return line.length > 0 && PASSWORD_PROMPT.test(line);
}

/**
 * The login a password prompt is asking about.
 *
 * `ssh` names the destination inside the prompt — `alice@203.0.113.13's
 * password:` — which makes the prompt better evidence for who is being asked
 * than anything read from the typed line. A command recalled from history, a
 * line typed while the app was reading something else, the same prompt asked
 * again after a refusal: none of those leave a command line that could be
 * classified, and the prompt says the same thing every time.
 *
 * A prompt that names nobody is not one of these: `sudo` and `su` ask with a
 * bare `Password:`, and their answer belongs to the account already in use
 * rather than to a login the vault could key on.
 */
const POSSESSIVE_PROMPT = /^([\w.-]{1,64})@([\w.:\[\]-]{1,255})['’]s\s+password\b[^:]*[:?]\s*$/i;

/** `Password for user@host:` — the shape plink and a few wrappers use. */
const PASSWORD_FOR_PROMPT = /^password for\s+([\w.-]{1,64})@([\w.:\[\]-]{1,255})\s*[:?]\s*$/i;

/**
 * `(user@host) Password:` — the shape the OpenSSH client paints when the server
 * offers keyboard-interactive authentication.
 *
 * Debian, Ubuntu and most appliances offer it, and the client prefers it over
 * the `password` method, so on those hosts this is the prompt a login actually
 * meets. It names the login and the address that was dialed in brackets rather
 * than with an apostrophe; a prompt nobody recognises is a prompt whose answer
 * the app can only attribute to a typed line it may not have been able to read.
 */
const KEYBOARD_INTERACTIVE_PROMPT = /^\(([\w.-]{1,64})@([\w.:\[\]-]{1,255})\)\s+password\b[^:]*[:?]\s*$/i;

export function passwordPromptTarget(text: string): { username: string; host: string } | null {
  const screen = promptOnScreen(text);
  if (!screen) return null;
  // A repaint that returned to column 0 leaves the prompt past the last CR.
  const line = screen.slice(screen.lastIndexOf('\r') + 1).trim();
  const match =
    POSSESSIVE_PROMPT.exec(line) ?? PASSWORD_FOR_PROMPT.exec(line) ?? KEYBOARD_INTERACTIVE_PROMPT.exec(line);
  if (!match) return null;
  const username = match[1];
  const host = match[2];
  if (!username || !host) return null;
  return { username, host };
}

/**
 * The account a `sudo` prompt says it is asking about.
 *
 * `sudo` on Debian and Ubuntu writes its own name into the prompt —
 * `[sudo] password for alice:` — and the account it names is the one running it,
 * which is the password it wants. Unlike the `ssh` prompts above it says
 * nothing about the machine, so it is only half an answer — the account — and
 * the machine comes from the hop the user is standing on. It is also the half
 * that survives a `sudo` recalled from history, whose command line nobody read.
 */
const SUDO_PROMPT = /^\[?sudo\]?\s+password\s+for\s+([\w.-]{1,32})\s*[:?]\s*$/i;

export function sudoPromptUser(text: string): { username: string } | null {
  const screen = promptOnScreen(text);
  if (!screen) return null;
  const line = screen.slice(screen.lastIndexOf('\r') + 1).trim();
  const match = SUDO_PROMPT.exec(line);
  const username = match?.[1];
  return username ? { username } : null;
}

/**
 * What has been typed into a line the terminal does not echo.
 *
 * A password may contain anything a keyboard can produce, but not the control
 * codes that travel with it: an arrow key arrives as three bytes and none of
 * them is text, and a backspace has to delete rather than be remembered as a
 * character. Ctrl-C is the caller's business — it cancels the prompt instead of
 * being part of the answer.
 */
export function typedAnswer(buffer: string, data: string): string {
  const text = data
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b./g, '');
  let answer = buffer;
  for (const char of text) {
    if (char === '\x7f' || char === '\b') answer = answer.slice(0, -1);
    else if (char >= ' ' && char !== '\x7f') answer += char;
  }
  // A paste is capped: nothing legitimate is longer, and the value is going to
  // be written straight into a prompt.
  return answer.length > 1024 ? answer.slice(-1024) : answer;
}

/**
 * The run of text the cursor is standing on in `text`.
 *
 * A terminal returns to column 0 with a bare CR — no line break — so what was
 * drawn on that line before is no longer what the user is looking at. Both
 * shapes happen right where this is read:
 *
 *   - a shell repaints its prompt over the old one instead of starting a line;
 *   - a shell that printed a report on its way out (`timed out waiting for
 *     input: auto-logout`) leaves the prompt of the shell underneath on that
 *     same line, after a CR.
 *
 * Reading only from the line start loses that prompt — which is how a session
 * whose account was logged out from under it kept reporting the old account.
 */
function screenTail(text: string): string {
  const runs = promptOnScreen(text).split('\r');
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = (runs[index] ?? '').trim();
    if (run) return run;
  }
  return '';
}

/**
 * `user@host` of the prompt at the end of `text`, if there is one.
 *
 * Both shapes a Linux prompt comes in are accepted: `user@host:~$` and the
 * bracketed `[user@host cwd]#` that CentOS, Kylin and RHEL ship as default. The
 * bracketed form is the one a prompt tracker missing it silently ignores, which
 * is why a nested login then only shows up when the typed line was seen.
 */
export function promptIdentity(text: string): { username: string; hostname: string } | null {
  if (!looksLikePromptTail(text)) return null;
  const match = /^[[(]?\s*([\w.-]{1,32})@([\w.-]{1,64})/.exec(screenTail(text));
  if (!match) return null;
  const username = match[1] as string;
  const hostname = match[2] as string;
  return { username, hostname };
}

export interface ShellInjection {
  /** The line to write into the terminal, without the trailing Enter. */
  line: string;
  beginMarker: string;
  endMarker: string;
}

/**
 * Builds the line typed by `SessionManager.execViaShell()`.
 *
 * The marker string is assembled at runtime (`"EAS"''"YSHELL-…"` is one shell
 * word), so the copy the shell echoes back never contains the marker verbatim
 * and cannot be mistaken for the start of the capture.
 */
export function buildShellInjection(token: string, command: string): ShellInjection {
  const beginMarker = `EASYSHELL-ESB-${token}`;
  const endMarker = `EASYSHELL-ESE-${token}`;
  const beginWord = `"EAS"''"YSHELL-ESB-${token}"`;
  const endWord = `"EAS"''"YSHELL-ESE-${token}"`;

  const line = [
    `printf '\\n%s' ${beginWord}`,
    `{ ${command} ; } 2>&1`,
    '__easyshell_code=$?',
    // `history 1` prints the newest entry; the token check keeps shells that
    // never recorded the line (HISTCONTROL=ignorespace, fish) from deleting
    // whatever came before it. Dash and friends have no history builtin at all,
    // which is why every step here is allowed to fail silently.
    '__easyshell_last=$({ history 1 ; } 2>/dev/null)',
    `case "$__easyshell_last" in *"YSHELL-ESB-${token}"*) history -d -1 2>/dev/null ;; esac`,
    'unset __easyshell_last',
    `printf '\\n%s:%s\\n' ${endWord} "$__easyshell_code"`,
    'unset __easyshell_code',
  ].join('; ');

  return { line: ` ${line}`, beginMarker, endMarker };
}

/**
 * The prompt text currently at the end of the display, for comparison with a
 * repaint. Escape sequences are dropped; only the last line matters.
 */
export function promptOnScreen(text: string): string {
  const lines = stripAnsi(text).split(/\r?\n/);
  return (lines[lines.length - 1] ?? '').trim();
}

/**
 * Decides what of the post-marker block reaches the display.
 *
 * The block is normally the shell repainting its prompt, sometimes more than
 * once. That prompt is already on screen, so printing the repaint is what makes
 * a prompt appear twice — or three times — on one line. A block whose every
 * line is prompt-shaped (or is exactly the prompt that was already there)
 * carries no output, so it is dropped. Anything else is shown on a fresh line,
 * because dropping it would swallow real output.
 */
export function injectionTailToDisplay(drained: string, promptBefore = ''): string {
  const text = stripAnsi(drained);
  if (!text.trim()) return '';

  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length > 0 && lines.every((line) => line === promptBefore || looksLikePromptTail(line))) {
    return '';
  }
  return /^[\r\n]/.test(drained) ? drained : `\r\n${drained}`;
}

/**
 * Escape sequences a prompt repaint is allowed to carry.
 *
 * Colour/style (`m`), bracketed paste and cursor visibility (`h`/`l`), OSC
 * titles, printable text and carriage returns. Anything that moves, erases or
 * clears — a real redraw, `Ctrl-L`, a resize — falls outside it and is never
 * treated as a repaint.
 */
const REPAINT_ONLY_CHUNK =
  /^(?:\x1b\[[0-9;?]*[mlh]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\t\r\x20-\x7e\u00a0-\uffff])*$/u;

/**
 * True when a chunk is nothing but the prompt the user is already looking at.
 *
 * Used for the short window after an injection: a shell on a slow link can paint
 * its prompt *after* the injection released the display, and printing that chunk
 * is what turns one prompt into two, or three.
 *
 * Only the prompt that was on screen *before* the injection counts. A different
 * prompt is news, not a repaint: leaving a nested login with `exit` makes the
 * machine underneath paint its own prompt, and swallowing that leaves the user
 * looking at a terminal with no prompt at all — which reads as a hung session.
 */
export function isBarePromptRepaint(chunk: string, promptBefore: string): boolean {
  if (!chunk) return false;
  // A chunk that opens a new line is new output, not a repaint of this line.
  if (/^[\r\n]/.test(chunk)) return false;
  if (!REPAINT_ONLY_CHUNK.test(chunk)) return false;
  // Nothing is known about the screen, so nothing may be hidden.
  if (!promptBefore) return false;

  const lines = stripAnsi(chunk)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return false;
  return lines.every((line) => line === promptBefore);
}

/**
 * Lines that mean the shell under the injection is being torn down: a nested
 * login ending with `exit`, an idle logout, a dropped connection, a closed
 * multiplexer.
 *
 * An injected line in such a shell can never print its end marker, so waiting
 * for the timeout would freeze the terminal for seconds — and then throw away
 * the very output that says the session ended.
 *
 * The text is read without its escape sequences, and the leading control bytes
 * are the BEL and mode switches a shell emits between the report and the CR that
 * starts its line.
 */
const SESSION_END =
  /(?:^|[\r\n])[\s\x00-\x1f]*(?:logout\b|timed out waiting for input|auto-logout|(?:Shared )?[Cc]onnection (?:to \S+ )?closed\.|[Cc]onnection closed by \S+|[Cc]onnection reset by \S+)/i;

export function looksLikeSessionEnd(text: string): boolean {
  return SESSION_END.test(stripAnsi(text));
}

/**
 * What of an interrupted capture may still be shown.
 *
 * The captured block is mostly the app's own line and its echo, which stay out
 * of the display; everything else in it is output the user would have seen if
 * the probe had never been typed there.
 */
export function injectionCaptureToDisplay(buffer: string): string {
  const lines = stripAnsi(buffer)
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => {
      if (!line.trim()) return false;
      // The typed line, its echo and either marker.
      if (line.includes('YSHELL-ES')) return false;
      if (line.includes('__easyshell')) return false;
      if (/^\s*printf '\\n/.test(line)) return false;
      return true;
    });
  return lines.join('\r\n');
}
