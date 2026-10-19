import * as pty from 'node-pty';
import headless, { type IBufferCell } from '@xterm/headless';
import path from 'node:path';

const esc = '\x1b[';
const { Terminal } = headless;

export async function runTerminalShell(options: {
  workdir: string;
  sessionId: string;
  apiUrl: string;
  browserUrl: string;
}): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      'The terminal UI requires an interactive TTY. Use --no-ui for server-only mode.',
    );
  const input = process.stdin;
  const output = process.stdout;
  const cols = Math.max(20, output.columns || 80);
  const rows = Math.max(2, (output.rows || 24) - 1);
  const terminal = new Terminal({ cols, rows, scrollback: 3000, allowProposedApi: true });
  const shell = process.env.SHELL || '/bin/bash';
  // node-pty removes TMUX and TMUX_PANE from its env. Restore them in the child
  // so a shell opened inside an existing tmux pane remains attached to it.
  const tmux = ['TMUX', 'TMUX_PANE']
    .filter((name) => process.env[name] !== undefined)
    .map((name) => `${name}=${process.env[name]}`);
  const child = pty.spawn('/usr/bin/env', [...tmux, shell, '-i'], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: options.workdir,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      FIELDWORK_WORKDIR: options.workdir,
      FIELDWORK_SESSION_ID: options.sessionId,
      SCENE_WORKSPACE_ID: options.sessionId,
      SCENE_API: options.apiUrl,
      PATH: `${path.join(options.workdir, '.fieldwork/bin')}:${process.env.PATH ?? ''}`,
    },
  });
  let previousLines: string[] = [];
  let mouseMode = 'none';
  let drawing = false;
  let pending = false;
  let inputRemainder = '';
  const header = () => {
    const label = ` Fieldwork  ${options.browserUrl} `;
    output.write(
      `${esc}1;1H${esc}0K${esc}7m\x1b]8;;${options.browserUrl}\x1b\\${label.slice(0, output.columns ?? 80)}\x1b]8;;\x1b\\${esc}0m`,
    );
  };
  const style = (cell: IBufferCell | undefined) => {
    if (!cell) return '';
    const codes: string[] = [];
    if (cell.isBold()) codes.push('1');
    if (cell.isDim()) codes.push('2');
    if (cell.isItalic()) codes.push('3');
    if (cell.isUnderline()) codes.push('4');
    if (cell.isInverse()) codes.push('7');
    if (cell.isFgRGB()) {
      const color = cell.getFgColor();
      codes.push(`38;2;${color >> 16};${(color >> 8) & 255};${color & 255}`);
    } else if (cell.isFgPalette()) codes.push(`38;5;${cell.getFgColor()}`);
    if (cell.isBgRGB()) {
      const color = cell.getBgColor();
      codes.push(`48;2;${color >> 16};${(color >> 8) & 255};${color & 255}`);
    } else if (cell.isBgPalette()) codes.push(`48;5;${cell.getBgColor()}`);
    return codes.length ? `${esc}${codes.join(';')}m` : '';
  };
  const render = () => {
    pending = false;
    if (drawing) {
      pending = true;
      return;
    }
    drawing = true;
    const buffer = terminal.buffer.active;
    const next: string[] = [];
    let out = `${esc}?25l`;
    for (let y = 0; y < terminal.rows; y++) {
      const line = buffer.getLine(buffer.viewportY + y);
      let rendered = '';
      let lastStyle = '';
      for (let x = 0; x < terminal.cols; x++) {
        const cell = line?.getCell(x);
        if (cell?.getWidth() === 0) continue;
        const nextStyle = style(cell);
        if (nextStyle !== lastStyle) {
          rendered += `${esc}0m${nextStyle}`;
          lastStyle = nextStyle;
        }
        rendered += cell?.getChars() || ' ';
      }
      next.push(rendered);
      if (previousLines[y] !== rendered) out += `${esc}${y + 2};1H${esc}0K${rendered}${esc}0m`;
    }
    previousLines = next;
    out += `${esc}${Math.min(output.rows ?? 24, buffer.cursorY + 2)};${buffer.cursorX + 1}H${esc}?25h`;
    output.write(out);
    drawing = false;
    if (pending) setImmediate(render);
  };
  const scheduleRender = () => {
    if (!pending) {
      pending = true;
      setImmediate(render);
    }
  };
  const updateMouse = () => {
    const next = terminal.modes.mouseTrackingMode;
    if (next === mouseMode) return;
    if (mouseMode !== 'none') output.write(`${esc}?1000l${esc}?1002l${esc}?1003l${esc}?1006l`);
    mouseMode = next;
    if (next !== 'none')
      output.write(
        `${esc}?${next === 'any' ? '1003' : next === 'drag' ? '1002' : '1000'}h${esc}?1006h`,
      );
  };
  const onData = child.onData((data) =>
    terminal.write(data, () => {
      updateMouse();
      scheduleRender();
    }),
  );
  const onInput = (chunk: Buffer) => {
    inputRemainder += chunk.toString('utf8');
    const mouse = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
    let translated = '';
    let cursor = 0;
    for (const match of inputRemainder.matchAll(mouse)) {
      const index = match.index ?? 0;
      translated += inputRemainder.slice(cursor, index);
      const y = Number(match[3]);
      if (y > 1) translated += `\x1b[<${match[1]};${match[2]};${y - 1}${match[4]}`;
      cursor = index + match[0].length;
    }
    const tail = inputRemainder.slice(cursor);
    const incomplete = tail.lastIndexOf('\x1b[<');
    if (incomplete >= 0 && !/[Mm]/.test(tail.slice(incomplete))) {
      translated += tail.slice(0, incomplete);
      inputRemainder = tail.slice(incomplete);
    } else {
      translated += tail;
      inputRemainder = '';
    }
    if (translated) child.write(translated);
  };
  const onResize = () => {
    const width = Math.max(20, output.columns || 80);
    const height = Math.max(2, (output.rows || 24) - 1);
    terminal.resize(width, height);
    child.resize(width, height);
    previousLines = [];
    output.write(`${esc}2J`);
    header();
    scheduleRender();
  };
  output.write('\x1b[?1049h\x1b[?25l\x1b[2J');
  header();
  input.setRawMode(true);
  input.resume();
  input.on('data', onInput);
  output.on('resize', onResize);
  scheduleRender();
  return new Promise<number>((resolve) => {
    child.onExit(({ exitCode }) => {
      onData.dispose();
      input.off('data', onInput);
      output.off('resize', onResize);
      if (mouseMode !== 'none') output.write(`${esc}?1000l${esc}?1002l${esc}?1003l${esc}?1006l`);
      input.setRawMode(false);
      input.pause();
      output.write('\x1b[?1049l\x1b[?25h');
      terminal.dispose();
      resolve(exitCode);
    });
  });
}
