import { ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface NativeController {
  move(dx: number, dy: number): Promise<void>;
  leftClick(): Promise<void>;
  rightClick(): Promise<void>;
  doubleClick(): Promise<void>;
  scroll(deltaY: number): Promise<void>;
  dragStart(): Promise<void>;
  dragEnd(): Promise<void>;
  maximizeWindow(): Promise<void>;
  restoreWindow(): Promise<void>;
  zoomIn(): Promise<void>;
  zoomOut(): Promise<void>;
  resetZoom(): Promise<void>;
  releaseAllButtons(): Promise<void>;
}

class FastWindowsNativeController implements NativeController {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private exePath = "";

  constructor() {
    this.init();
  }

  private init() {
    try {
      this.exePath = this.resolveOrCompile();
      this.startProcess();
    } catch (err) {
      console.error("[native-controller] Failed to initialize native injector:", err);
    }
  }

  private resolveOrCompile(): string {
    const candidatePaths = [
      path.resolve(__dirname, "../input-injector.exe"),
      path.resolve(__dirname, "../../companion/input-injector.exe"),
      path.resolve(process.cwd(), "companion/input-injector.exe"),
      path.resolve(process.cwd(), "input-injector.exe"),
    ];

    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    // Attempt to compile using csc.exe if available
    const cscPath = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
    const srcPath = path.resolve(__dirname, "input-injector.cs");
    const fallbackSrcPath = path.resolve(process.cwd(), "companion/src/input-injector.cs");
    const actualSrc = fs.existsSync(srcPath) ? srcPath : (fs.existsSync(fallbackSrcPath) ? fallbackSrcPath : "");

    const outPath = candidatePaths[0];

    if (fs.existsSync(cscPath) && actualSrc) {
      console.log(`[native-controller] Compiling input-injector.exe with csc.exe...`);
      execFileSync(cscPath, [
        "/nologo",
        "/optimize",
        "/target:winexe",
        `/out:${outPath}`,
        "/reference:System.Windows.Forms.dll",
        actualSrc,
      ]);
      return outPath;
    }

    throw new Error("Could not find or compile input-injector.exe");
  }

  private startProcess() {
    if (!this.exePath || !fs.existsSync(this.exePath)) return;

    this.proc = spawn(this.exePath, [], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout.on("data", (data) => {
      const msg = data.toString().trim();
      if (msg.includes("READY")) {
        console.log("[native-controller] Fast native input injector READY");
      }
    });

    this.proc.on("error", (err) => {
      console.error("[native-controller] Input injector error:", err);
    });

    this.proc.on("exit", (code) => {
      console.warn(`[native-controller] Input injector exited with code ${code}. Restarting...`);
      this.proc = null;
      setTimeout(() => this.startProcess(), 500);
    });
  }

  private sendCommand(cmd: string) {
    if (!this.proc || !this.proc.stdin || this.proc.killed) {
      this.startProcess();
    }
    if (this.proc && this.proc.stdin.writable) {
      this.proc.stdin.write(`${cmd}\n`);
    }
  }

  async move(dx: number, dy: number): Promise<void> {
    this.sendCommand(`m ${dx} ${dy}`);
  }

  async leftClick(): Promise<void> {
    this.sendCommand("lc");
  }

  async rightClick(): Promise<void> {
    this.sendCommand("rc");
  }

  async doubleClick(): Promise<void> {
    this.sendCommand("dc");
  }

  async scroll(deltaY: number): Promise<void> {
    this.sendCommand(`s ${deltaY}`);
  }

  async dragStart(): Promise<void> {
    this.sendCommand("ld");
  }

  async dragEnd(): Promise<void> {
    this.sendCommand("lu");
  }

  async maximizeWindow(): Promise<void> {
    this.sendCommand("max");
  }

  async restoreWindow(): Promise<void> {
    this.sendCommand("rst");
  }

  async zoomIn(): Promise<void> {
    this.sendCommand("zi");
  }

  async zoomOut(): Promise<void> {
    this.sendCommand("zo");
  }

  async resetZoom(): Promise<void> {
    this.sendCommand("zr");
  }

  async releaseAllButtons(): Promise<void> {
    this.sendCommand("rel");
  }
}

class NoopController implements NativeController {
  async move(): Promise<void> {}
  async leftClick(): Promise<void> {}
  async rightClick(): Promise<void> {}
  async doubleClick(): Promise<void> {}
  async scroll(): Promise<void> {}
  async dragStart(): Promise<void> {}
  async dragEnd(): Promise<void> {}
  async maximizeWindow(): Promise<void> {}
  async restoreWindow(): Promise<void> {}
  async zoomIn(): Promise<void> {}
  async zoomOut(): Promise<void> {}
  async resetZoom(): Promise<void> {}
  async releaseAllButtons(): Promise<void> {}
}

export function createNativeController(): NativeController {
  if (process.platform === "win32") return new FastWindowsNativeController();
  return new NoopController();
}
