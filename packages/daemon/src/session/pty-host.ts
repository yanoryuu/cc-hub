// PtyHost + ScreenModel: 1 セッション分の PTY(node-pty / ConPTY)と、画面状態を保持する headless xterm。
import * as pty from '@lydell/node-pty';
import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';

export const SCROLLBACK = 5000;
export const SNAPSHOT_SCROLLBACK = 2000;

export interface SpawnOptions {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export class PtyHost {
  proc: pty.IPty | null = null;
  readonly term: Terminal;
  private readonly serializer: SerializeAddon;
  cols: number;
  rows: number;
  /** PTY 出力ごとに呼ばれる(term への書き込み後) */
  onData: (data: string) => void = () => {};
  onExit: (exitCode: number) => void = () => {};

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.term = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    // headless の Terminal と addon の型定義(@xterm/xterm 側)が別物なのでキャストする
    this.term.loadAddon(this.serializer as unknown as Parameters<Terminal['loadAddon']>[0]);
  }

  get alive(): boolean {
    return this.proc !== null;
  }

  spawn(o: SpawnOptions): void {
    if (this.proc) throw new Error('already running');
    const p = pty.spawn(o.file, o.args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: o.cwd,
      env: o.env,
    });
    this.proc = p;
    p.onData((data) => {
      this.term.write(data);
      this.onData(data);
    });
    p.onExit(({ exitCode }) => {
      if (this.proc === p) this.proc = null;
      this.onExit(exitCode);
    });
  }

  write(data: string): void {
    this.proc?.write(data);
  }

  /** 画面にだけ書く(デーモンからのお知らせ行など) */
  writeLocal(data: string): void {
    this.term.write(data);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.term.resize(cols, rows);
    try {
      this.proc?.resize(cols, rows);
    } catch {
      /* 終了直後の resize は無視 */
    }
  }

  kill(): void {
    try {
      this.proc?.kill();
    } catch {
      /* 既に終了 */
    }
  }

  /** これまでに書き込んだ出力がすべて解析されてからスナップショットを取る */
  snapshot(cb: (data: string) => void): void {
    this.term.write('', () => cb(this.serializer.serialize({ scrollback: SNAPSHOT_SCROLLBACK })));
  }

  /** 画面の末尾 n 行(現在表示中の領域の下端から) */
  /**
   * 画面末尾の n 行。末尾の空行は数えない(行数が多い画面では、上寄せで描かれたダイアログが
   * 下の空行に押し出されて検出範囲から外れるため)。範囲は表示中の画面内に限る。
   */
  tailLines(n: number): string[] {
    const buf = this.term.buffer.active;
    const top = buf.baseY;
    let end = buf.baseY + this.term.rows;
    while (end > top) {
      const line = buf.getLine(end - 1);
      if (line && line.translateToString(true).trim()) break;
      end--;
    }
    const lines: string[] = [];
    for (let i = Math.max(top, end - n); i < end; i++) {
      const line = buf.getLine(i);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines;
  }

  dispose(): void {
    this.kill();
    this.term.dispose();
  }
}
