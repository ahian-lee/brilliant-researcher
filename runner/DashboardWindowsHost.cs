// A WinExe has no console; DETACHED_PROCESS prevents the child from inheriting one.
// The Job Object closes the child if this host disappears. Windows owns restarts.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class DashboardWindowsHost {
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {
        public ulong ReadCount, WriteCount, OtherCount, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits limits, int size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {
        public int Length; public IntPtr Descriptor; public int Inherit;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo {
        public int Size; public string Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
        public short Show, ReservedSize; public IntPtr ReservedData, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInformation {
        public IntPtr Process, Thread; public uint ProcessId, ThreadId;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr CreateFile(string file, uint access, uint share, ref SecurityAttributes attributes, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInformation process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    static readonly object OutputLock = new object();
    static void Append(string file, string value) {
        lock (OutputLock) using (var stream = new FileStream(file, FileMode.Append, FileAccess.Write, FileShare.ReadWrite))
            using (var writer = new StreamWriter(stream, new UTF8Encoding(false))) writer.WriteLine(value);
    }
    static string Quote(string value) {
        var result = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes); slashes = 0;
            result.Append(c);
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    static IntPtr OpenStandardFile(string file, uint access) {
        var attributes = new SecurityAttributes { Length=Marshal.SizeOf(typeof(SecurityAttributes)), Inherit=1 };
        IntPtr handle = CreateFile(file, access, 3, ref attributes, file == "NUL" ? 3u : 4u, 0x80, IntPtr.Zero);
        if (handle == new IntPtr(-1)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        return handle;
    }
    static void WriteState(string file, Process child, Process host) {
        string json = "{\"pid\":" + child.Id + ",\"startTicks\":\"" + child.StartTime.ToUniversalTime().Ticks + "\",\"hostPid\":" + host.Id + ",\"hostStartTicks\":\"" + host.StartTime.ToUniversalTime().Ticks + "\"}";
        string temp = file + ".tmp";
        File.WriteAllText(temp, json, new UTF8Encoding(false));
        if (File.Exists(file)) File.Replace(temp, file, null); else File.Move(temp, file);
    }
    [STAThread] public static int Main(string[] args) {
        // node, entry, first node argument (projects), port, ownership, lifecycle, out, err
        if (args.Length != 8) return 2;
        string log = args[5];
        IntPtr job = IntPtr.Zero;
        IntPtr input = IntPtr.Zero, output = IntPtr.Zero, errorOutput = IntPtr.Zero;
        var nativeChild = new ProcessInformation();
        Process child = null;
        try {
            var host = Process.GetCurrentProcess();
            Append(log, DateTime.UtcNow.ToString("o") + " host started pid=" + host.Id + " console=" + GetConsoleWindow());
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            var limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE
            if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimits))))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            input = OpenStandardFile("NUL", 0x80000000);
            output = OpenStandardFile(args[6], 4); errorOutput = OpenStandardFile(args[7], 4); // FILE_APPEND_DATA
            var startup = new StartupInfo { Size=Marshal.SizeOf(typeof(StartupInfo)), Flags=0x100, Input=input, Output=output, Error=errorOutput };
            Environment.SetEnvironmentVariable("BRI_DASHBOARD_MANAGED", "1");
            string command = Quote(args[0]) + " " + Quote(args[1]) + " " + Quote(args[2]) + " " + Quote(args[3]);
            // Suspend until job ownership is established, avoiding an orphan on host failure.
            if (!CreateProcess(args[0], new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, true, 0x8 | 0x4, IntPtr.Zero, Environment.CurrentDirectory, ref startup, out nativeChild))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            if (!AssignProcessToJobObject(job, nativeChild.Process))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            child = Process.GetProcessById((int)nativeChild.ProcessId);
            WriteState(args[4], child, host);
            Append(log, DateTime.UtcNow.ToString("o") + " child started pid=" + child.Id + " startTicks=" + child.StartTime.ToUniversalTime().Ticks);
            if (ResumeThread(nativeChild.Thread) == 0xFFFFFFFF)
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            if (WaitForSingleObject(nativeChild.Process, 0xFFFFFFFF) != 0)
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            uint nativeCode;
            if (!GetExitCodeProcess(nativeChild.Process, out nativeCode))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            int code = unchecked((int)nativeCode);
            Append(log, DateTime.UtcNow.ToString("o") + " child exited pid=" + child.Id + " code=" + code + " hex=" + unchecked((uint)code).ToString("X8"));
            return code;
        } catch (Exception error) {
            if (nativeChild.Process != IntPtr.Zero) TerminateProcess(nativeChild.Process, 1);
            Append(log, DateTime.UtcNow.ToString("o") + " host error: " + error);
            return 1;
        } finally {
            if (job != IntPtr.Zero) CloseHandle(job);
            if (nativeChild.Thread != IntPtr.Zero) CloseHandle(nativeChild.Thread);
            if (nativeChild.Process != IntPtr.Zero) CloseHandle(nativeChild.Process);
            foreach (IntPtr handle in new[] { input, output, errorOutput }) if (handle != IntPtr.Zero) CloseHandle(handle);
            if (child != null) child.Dispose();
        }
    }
}
