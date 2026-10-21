using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

class Program {
    [DllImport("user32.dll")]
    static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll")]
    static extern bool GetCursorPos(out POINT pt);

    [DllImport("user32.dll", SetLastError = true)]
    static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, UIntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    const uint MOUSEEVENTF_MOVE = 0x0001;
    const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    const uint MOUSEEVENTF_LEFTUP = 0x0004;
    const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    const uint MOUSEEVENTF_WHEEL = 0x0800;

    static void Main(string[] args) {
        Console.WriteLine("READY");
        string line;
        while ((line = Console.ReadLine()) != null) {
            try {
                if (string.IsNullOrWhiteSpace(line)) continue;
                string[] parts = line.Trim().Split(' ');
                string cmd = parts[0];

                switch (cmd) {
                    case "m": // move dx dy
                        if (parts.Length >= 3) {
                            double dxd = 0, dyd = 0;
                            if (double.TryParse(parts[1], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out dxd) &&
                                double.TryParse(parts[2], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out dyd)) {
                                int dx = (int)Math.Round(dxd);
                                int dy = (int)Math.Round(dyd);
                                POINT p;
                                bool moved = false;
                                if (GetCursorPos(out p)) {
                                    moved = SetCursorPos(p.X + dx, p.Y + dy);
                                }
                                if (!moved) {
                                    mouse_event(MOUSEEVENTF_MOVE, dx, dy, 0, UIntPtr.Zero);
                                }
                            }
                        }
                        break;
                    case "pos": // set absolute pos x y
                        if (parts.Length >= 3) {
                            int x = int.Parse(parts[1], System.Globalization.CultureInfo.InvariantCulture);
                            int y = int.Parse(parts[2], System.Globalization.CultureInfo.InvariantCulture);
                            SetCursorPos(x, y);
                        }
                        break;
                    case "ld": // left down / drag start
                        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
                        break;
                    case "lu": // left up / drag end
                        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
                        break;
                    case "lc": // left click
                        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
                        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
                        break;
                    case "rc": // right click
                        mouse_event(MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, UIntPtr.Zero);
                        mouse_event(MOUSEEVENTF_RIGHTUP, 0, 0, 0, UIntPtr.Zero);
                        break;
                    case "dc": // double click
                        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
                        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
                        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
                        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
                        break;
                    case "s": // scroll
                        if (parts.Length >= 2) {
                            double d = 0;
                            if (double.TryParse(parts[1], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out d)) {
                                int delta = (int)Math.Round(d * -10);
                                mouse_event(MOUSEEVENTF_WHEEL, 0, 0, delta, UIntPtr.Zero);
                            }
                        }
                        break;
                    case "max":
                        IntPtr w1 = GetForegroundWindow();
                        if (w1 != IntPtr.Zero) ShowWindow(w1, 3);
                        break;
                    case "rst":
                        IntPtr w2 = GetForegroundWindow();
                        if (w2 != IntPtr.Zero) ShowWindow(w2, 9);
                        break;
                    case "zi":
                        SendKeys.SendWait("^{+}");
                        break;
                    case "zo":
                        SendKeys.SendWait("^-");
                        break;
                    case "zr":
                        SendKeys.SendWait("^0");
                        break;
                    case "rel":
                        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
                        mouse_event(MOUSEEVENTF_RIGHTUP, 0, 0, 0, UIntPtr.Zero);
                        break;
                    case "ping":
                        Console.WriteLine("PONG");
                        break;
                    case "quit":
                        return;
                }
            } catch {
                // keep running
            }
        }
    }
}
