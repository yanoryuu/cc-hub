// gamecap.exe - ウィンドウキャプチャ & 入力注入ヘルパー (CC Remote 用)
//
// 使い方:
//   gamecap.exe list
//       可視トップレベルウィンドウを JSON Lines で出力 ({"hwnd":1234,"title":"..."})
//   gamecap.exe stream <hwnd> <fps> <quality> <maxWidth>
//       stdout: [4byte LE 長さ][JPEG] の繰り返し
//       stdin : テキストコマンド (click/down/move/up nx ny) nx,ny は 0..1 の正規化クライアント座標
//
// コンパイル: csc /target:exe /out:gamecap.exe /r:System.Drawing.dll gamecap.cs
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

class GameCap
{
    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int X, Y; }

    delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);

    const uint PW_RENDERFULLCONTENT = 2; // GPU 描画 (Unity 等) のウィンドウも取れる
    const int SM_XVIRTUALSCREEN = 76, SM_YVIRTUALSCREEN = 77, SM_CXVIRTUALSCREEN = 78, SM_CYVIRTUALSCREEN = 79;

    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)]
    struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public INPUTUNION u; }
    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004,
               MOUSEEVENTF_ABSOLUTE = 0x8000, MOUSEEVENTF_VIRTUALDESK = 0x4000;
    const uint KEYEVENTF_EXTENDEDKEY = 0x0001, KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;

    [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);

    static int Main(string[] args)
    {
        SetProcessDPIAware();
        if (args.Length >= 1 && args[0] == "list") return CmdList();
        if (args.Length >= 5 && args[0] == "stream")
            return CmdStream(new IntPtr(long.Parse(args[1])), int.Parse(args[2]), long.Parse(args[3]), int.Parse(args[4]));
        Console.Error.WriteLine("usage: gamecap list | gamecap stream <hwnd> <fps> <quality> <maxWidth>");
        return 2;
    }

    static string JsonEscape(string s)
    {
        var sb = new StringBuilder();
        foreach (char c in s)
        {
            if (c == '"' || c == '\\') { sb.Append('\\'); sb.Append(c); }
            else if (c < 0x20) sb.AppendFormat("\\u{0:x4}", (int)c);
            else sb.Append(c);
        }
        return sb.ToString();
    }

    static int CmdList()
    {
        var stdout = Console.OpenStandardOutput();
        var w = new StreamWriter(stdout, new UTF8Encoding(false));
        EnumWindows((h, l) =>
        {
            if (!IsWindowVisible(h)) return true;
            var sb = new StringBuilder(512);
            GetWindowText(h, sb, 512);
            string title = sb.ToString();
            if (title.Length == 0) return true;
            RECT rc;
            GetClientRect(h, out rc);
            if (rc.Right - rc.Left < 100 || rc.Bottom - rc.Top < 100) return true; // 小さいのは除外
            w.WriteLine("{\"hwnd\":" + h.ToInt64() + ",\"title\":\"" + JsonEscape(title) + "\",\"w\":" + (rc.Right - rc.Left) + ",\"h\":" + (rc.Bottom - rc.Top) + "}");
            return true;
        }, IntPtr.Zero);
        w.Flush();
        return 0;
    }

    static ImageCodecInfo JpegCodec()
    {
        foreach (var c in ImageCodecInfo.GetImageEncoders())
            if (c.FormatID == ImageFormat.Jpeg.Guid) return c;
        return null;
    }

    static int CmdStream(IntPtr hwnd, int fps, long quality, int maxWidth)
    {
        var stdout = Console.OpenStandardOutput();
        var codec = JpegCodec();
        var encp = new EncoderParameters(1);
        encp.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);

        // stdin の入力コマンドを別スレッドで処理
        var t = new Thread(() => InputLoop(hwnd)) { IsBackground = true };
        t.Start();

        int interval = Math.Max(30, 1000 / Math.Max(1, fps));
        byte[] lenBuf = new byte[4];
        while (IsWindow(hwnd))
        {
            var sw = Environment.TickCount;
            try
            {
                if (!IsIconic(hwnd))
                {
                    RECT rc;
                    GetClientRect(hwnd, out rc);
                    int cw = rc.Right - rc.Left, ch = rc.Bottom - rc.Top;
                    if (cw > 0 && ch > 0)
                    {
                        using (var bmp = new Bitmap(cw, ch, PixelFormat.Format32bppRgb))
                        {
                            using (var g = Graphics.FromImage(bmp))
                            {
                                IntPtr hdc = g.GetHdc();
                                PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT | 1); // 1 = PW_CLIENTONLY
                                g.ReleaseHdc(hdc);
                            }
                            Bitmap outBmp = bmp;
                            if (cw > maxWidth)
                            {
                                int nh = (int)((long)ch * maxWidth / cw);
                                outBmp = new Bitmap(bmp, new Size(maxWidth, nh));
                            }
                            using (var ms = new MemoryStream())
                            {
                                outBmp.Save(ms, codec, encp);
                                if (!ReferenceEquals(outBmp, bmp)) outBmp.Dispose();
                                byte[] jpg = ms.ToArray();
                                lenBuf[0] = (byte)(jpg.Length); lenBuf[1] = (byte)(jpg.Length >> 8);
                                lenBuf[2] = (byte)(jpg.Length >> 16); lenBuf[3] = (byte)(jpg.Length >> 24);
                                stdout.Write(lenBuf, 0, 4);
                                stdout.Write(jpg, 0, jpg.Length);
                                stdout.Flush();
                            }
                        }
                    }
                }
            }
            catch (Exception e) { Console.Error.WriteLine("capture error: " + e.Message); }
            int elapsed = Environment.TickCount - sw;
            if (elapsed < interval) Thread.Sleep(interval - elapsed);
        }
        return 0;
    }

    // ---- 入力注入 ----
    static void InputLoop(IntPtr hwnd)
    {
        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            try
            {
                var p = line.Trim().Split(' ');
                if (p.Length < 2) continue;
                if (p[0] == "keydown" || p[0] == "keyup")
                {
                    Key(hwnd, ushort.Parse(p[1]), p[0] == "keyup");
                    continue;
                }
                if (p[0] == "text")
                {
                    SendText(hwnd, Encoding.UTF8.GetString(Convert.FromBase64String(p[1])));
                    continue;
                }
                if (p.Length < 3) continue;
                double nx = double.Parse(p[1]), ny = double.Parse(p[2]);
                switch (p[0])
                {
                    case "click": MoveTo(hwnd, nx, ny); Mouse(MOUSEEVENTF_LEFTDOWN); Thread.Sleep(40); Mouse(MOUSEEVENTF_LEFTUP); break;
                    case "down": MoveTo(hwnd, nx, ny); Mouse(MOUSEEVENTF_LEFTDOWN); break;
                    case "move": MoveTo(hwnd, nx, ny); break;
                    case "up": MoveTo(hwnd, nx, ny); Mouse(MOUSEEVENTF_LEFTUP); break;
                }
            }
            catch (Exception e) { Console.Error.WriteLine("input error: " + e.Message); }
        }
    }

    static void MoveTo(IntPtr hwnd, double nx, double ny)
    {
        SetForegroundWindow(hwnd);
        RECT rc;
        GetClientRect(hwnd, out rc);
        var pt = new POINT { X = (int)(nx * (rc.Right - rc.Left)), Y = (int)(ny * (rc.Bottom - rc.Top)) };
        ClientToScreen(hwnd, ref pt);
        int vx = GetSystemMetrics(SM_XVIRTUALSCREEN), vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
        int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN), vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        int ax = (int)(((double)(pt.X - vx)) * 65535 / (vw - 1));
        int ay = (int)(((double)(pt.Y - vy)) * 65535 / (vh - 1));
        var inp = new INPUT[1];
        inp[0].type = INPUT_MOUSE;
        inp[0].u.mi.dx = ax; inp[0].u.mi.dy = ay;
        inp[0].u.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
        SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
    }

    static void Mouse(uint flag)
    {
        var inp = new INPUT[1];
        inp[0].type = INPUT_MOUSE;
        inp[0].u.mi.dwFlags = flag;
        SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
    }

    // 拡張キー (矢印・Home/End/PgUp/PgDn/Ins/Del 等) は EXTENDEDKEY フラグが必要
    static bool IsExtendedKey(int vk)
    {
        return (vk >= 0x21 && vk <= 0x2E) || vk == 0x5B || vk == 0x5C || vk == 0xA3 || vk == 0xA5;
    }

    // 文字列送信: 英数字・空白は VK (Unity の GetKey 系でも拾える)、それ以外は Unicode 注入
    static void SendText(IntPtr hwnd, string s)
    {
        SetForegroundWindow(hwnd);
        Thread.Sleep(20);
        foreach (char c in s)
        {
            if (c == '\r') continue;
            if (c == '\n') { Key(hwnd, 0x0D, false); Key(hwnd, 0x0D, true); continue; }
            if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == ' ')
            {
                ushort vk = (ushort)char.ToUpper(c);
                Key(hwnd, vk, false);
                Key(hwnd, vk, true);
                continue;
            }
            var inp = new INPUT[2];
            inp[0].type = INPUT_KEYBOARD;
            inp[0].u.ki.wScan = c;
            inp[0].u.ki.dwFlags = KEYEVENTF_UNICODE;
            inp[1].type = INPUT_KEYBOARD;
            inp[1].u.ki.wScan = c;
            inp[1].u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
            SendInput(2, inp, Marshal.SizeOf(typeof(INPUT)));
        }
    }

    static void Key(IntPtr hwnd, ushort vk, bool up)
    {
        SetForegroundWindow(hwnd);
        var inp = new INPUT[1];
        inp[0].type = INPUT_KEYBOARD;
        inp[0].u.ki.wVk = vk;
        inp[0].u.ki.wScan = (ushort)MapVirtualKey(vk, 0);
        uint flags = up ? KEYEVENTF_KEYUP : 0;
        if (IsExtendedKey(vk)) flags |= KEYEVENTF_EXTENDEDKEY;
        inp[0].u.ki.dwFlags = flags;
        SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
    }
}
