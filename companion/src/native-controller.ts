import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

function ps(script: string): Promise<void> {
  return execFileAsync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { windowsHide: true },
  ).then(() => undefined);
}

class WindowsPowerShellController implements NativeController {
  private readonly user32Prelude = `Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Native {
  [DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport(\"user32.dll\")] public static extern bool GetCursorPos(out POINT pt);
  [DllImport(\"user32.dll\")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();
  [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
}
"@;`;

  private async run(body: string): Promise<void> {
    await ps(`${this.user32Prelude} ${body}`);
  }

  async move(dx: number, dy: number): Promise<void> {
    const x = Math.round(dx);
    const y = Math.round(dy);
    await this.run(`$p=New-Object Native+POINT; [Native]::GetCursorPos([ref]$p)|Out-Null; [Native]::SetCursorPos($p.X+${x},$p.Y+${y})|Out-Null;`);
  }

  async leftClick(): Promise<void> {
    await this.run("[Native]::mouse_event(0x0002,0,0,0,[UIntPtr]::Zero); [Native]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero);");
  }

  async rightClick(): Promise<void> {
    await this.run("[Native]::mouse_event(0x0008,0,0,0,[UIntPtr]::Zero); [Native]::mouse_event(0x0010,0,0,0,[UIntPtr]::Zero);");
  }

  async doubleClick(): Promise<void> {
    await this.leftClick();
    await this.leftClick();
  }

  async scroll(deltaY: number): Promise<void> {
    const amt = Math.round(deltaY * -10);
    await this.run(`[Native]::mouse_event(0x0800,0,0,${amt},[UIntPtr]::Zero);`);
  }

  async dragStart(): Promise<void> {
    await this.run("[Native]::mouse_event(0x0002,0,0,0,[UIntPtr]::Zero);");
  }

  async dragEnd(): Promise<void> {
    await this.run("[Native]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero);");
  }

  async maximizeWindow(): Promise<void> {
    await this.run("$w=[Native]::GetForegroundWindow(); if($w -ne [IntPtr]::Zero){[Native]::ShowWindow($w,3)|Out-Null}");
  }

  async restoreWindow(): Promise<void> {
    await this.run("$w=[Native]::GetForegroundWindow(); if($w -ne [IntPtr]::Zero){[Native]::ShowWindow($w,9)|Out-Null}");
  }

  async zoomIn(): Promise<void> {
    await ps("Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^+{ADD}')");
  }

  async zoomOut(): Promise<void> {
    await ps("Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^-')");
  }

  async resetZoom(): Promise<void> {
    await ps("Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^0')");
  }

  async releaseAllButtons(): Promise<void> {
    await this.run("[Native]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero); [Native]::mouse_event(0x0010,0,0,0,[UIntPtr]::Zero);");
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
  if (process.platform === "win32") return new WindowsPowerShellController();
  return new NoopController();
}
