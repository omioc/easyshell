/**
 * Clipboard write with a synchronous fallback: the async Clipboard API is
 * missing in some embedded/ insecure contexts, and a copy button that silently
 * does nothing is worse than the deprecated path.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the textarea trick */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/**
 * How many lines a paste carries.
 *
 * A copied block usually ends in a newline; that one is not a line. One line
 * goes straight into the terminal, more than one is asked about first, because
 * a paste that turns out to be a script is not something to find out afterwards.
 */
export function pastedLineCount(text: string): number {
  const body = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  return body.split('\n').length;
}
