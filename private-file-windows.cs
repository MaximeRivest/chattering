// Windows key storage: security, identity, bytes and publication use one handle.
// CREATE_NEW receives the owner-only descriptor at object creation. No empty
// permissively inherited file, pathname ACL mutation, or pathname reopen exists.
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

public static class ChatteringPrivateFile {
    const uint FullControl = 0x001F01FF;
    const uint OpenReparsePoint = 0x00200000;
    [StructLayout(LayoutKind.Sequential)]
    struct SecurityAttributes {
        public int Length;
        public IntPtr Descriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool InheritHandle;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct FileInformation {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct RenameInformation {
        [MarshalAs(UnmanagedType.Bool)] public bool Replace;
        public IntPtr Root;
        public uint Length;
        [MarshalAs(UnmanagedType.U2)] public char Name;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFileW(string file, uint access, uint sharing,
        IntPtr attributes, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation info);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint GetFileType(SafeFileHandle handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, IntPtr info, uint size);

    static SecurityIdentifier User { get { return WindowsIdentity.GetCurrent().User; } }
    static FileSecurity PrivateSecurity() {
        var acl = new FileSecurity();
        acl.SetAccessRuleProtection(true, false);
        acl.SetOwner(User);
        acl.AddAccessRule(new FileSystemAccessRule(User, FileSystemRights.FullControl, AccessControlType.Allow));
        return acl;
    }
    // FileShare.None excludes existing retained reader handles and concurrent
    // replacement/deletion. OPEN_REPARSE_POINT makes a leaf alias inspectable
    // rather than following it. Parent aliases still resolve to a checked object.
    public static FileStream Open(string file, bool create) {
        return Acquire(file, create, false);
    }
    static FileStream Acquire(string file, bool create, bool missing) {
        IntPtr descriptor = IntPtr.Zero, attributes = IntPtr.Zero;
        SafeFileHandle handle = null;
        try {
            if (create) {
                byte[] bytes = PrivateSecurity().GetSecurityDescriptorBinaryForm();
                descriptor = Marshal.AllocHGlobal(bytes.Length);
                Marshal.Copy(bytes, 0, descriptor, bytes.Length);
                var sa = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = descriptor, InheritHandle = false };
                attributes = Marshal.AllocHGlobal(sa.Length);
                Marshal.StructureToPtr(sa, attributes, false);
            }
            handle = CreateFileW(Path.GetFullPath(file), FullControl, 0, attributes, create ? 1u : 3u, OpenReparsePoint, IntPtr.Zero);
            if (handle.IsInvalid) {
                int error = Marshal.GetLastWin32Error();
                // Absence is recognized here, at initial acquisition ONLY.
                if (!create && missing && (error == 2 || error == 3)) return null;
                throw new Win32Exception(error);
            }
            ValidateObject(handle);
            var stream = new FileStream(handle, FileAccess.ReadWrite, 4096, false);
            handle = null; // ownership transferred to FileStream
            return stream;
        } finally {
            if (handle != null) handle.Dispose();
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (descriptor != IntPtr.Zero) Marshal.FreeHGlobal(descriptor);
        }
    }
    static void ValidateObject(SafeFileHandle handle) {
        FileInformation info;
        if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (GetFileType(handle) != 1 || (info.Attributes & (0x10u | 0x400u)) != 0 || info.Links != 1)
            throw new IOException("Key storage must be a singly linked regular file, not a reparse point");
    }
    public static void Check(FileStream stream) {
        ValidateObject(stream.SafeFileHandle);
        // FileStream's API obtains the descriptor using its SafeFileHandle.
        var acl = stream.GetAccessControl();
        var rules = acl.GetAccessRules(true, true, typeof(SecurityIdentifier));
        if (!acl.AreAccessRulesProtected || !acl.GetOwner(typeof(SecurityIdentifier)).Equals(User) || rules.Count != 1)
            throw new IOException("Key file is not owner-only");
        var rule = (FileSystemAccessRule)rules[0];
        if (!rule.IdentityReference.Equals(User) || rule.IsInherited || rule.AccessControlType != AccessControlType.Allow || rule.FileSystemRights != FileSystemRights.FullControl)
            throw new IOException("Unexpected key access rule");
    }
    public static void Protect(FileStream stream) {
        if (!stream.GetAccessControl().GetOwner(typeof(SecurityIdentifier)).Equals(User))
            throw new IOException("Key storage has a foreign owner");
        // Exclusivity prevents a permissive legacy file's old reader from
        // surviving protection. A sharing violation fails closed, not absence.
        stream.SetAccessControl(PrivateSecurity());
        Check(stream);
    }
    static FileStream ExistingOrAbsent(string file) {
        return Acquire(file, false, true);
    }
    public static bool Inspect(string file, bool protect) {
        using (var stream = ExistingOrAbsent(file)) {
            if (stream == null) return false;
            if (protect) Protect(stream); else Check(stream);
            return true;
        }
    }
    public static byte[] Read(string file) {
        using (var stream = ExistingOrAbsent(file)) {
            if (stream == null) return null;
            Protect(stream);
            if (stream.Length > 1024 * 1024) throw new IOException("Key storage exceeds budget");
            using (var bytes = new MemoryStream()) {
                stream.CopyTo(bytes);
                return bytes.ToArray();
            }
        }
    }
    public static string ReadEncoded(string file) {
        byte[] bytes = Read(file);
        return bytes == null ? "ABSENT" : "DATA:" + Convert.ToBase64String(bytes);
    }
    static void Rename(FileStream stream, string destination) {
        byte[] name = System.Text.Encoding.Unicode.GetBytes(Path.GetFullPath(destination));
        int nameOffset = (int)Marshal.OffsetOf(typeof(RenameInformation), "Name");
        int size = checked(nameOffset + name.Length);
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try {
            Marshal.Copy(new byte[size], 0, buffer, size);
            Marshal.WriteInt32(buffer, 0, 1); // ReplaceIfExists
            Marshal.WriteInt32(buffer, (int)Marshal.OffsetOf(typeof(RenameInformation), "Length"), name.Length);
            Marshal.Copy(name, 0, IntPtr.Add(buffer, nameOffset), name.Length);
            if (!SetFileInformationByHandle(stream.SafeFileHandle, 3, buffer, (uint)size)) throw new Win32Exception(Marshal.GetLastWin32Error());
        } finally { Marshal.FreeHGlobal(buffer); }
    }
    static void Erase(FileStream stream) {
        IntPtr buffer = Marshal.AllocHGlobal(4);
        try {
            Marshal.WriteInt32(buffer, 1);
            if (!SetFileInformationByHandle(stream.SafeFileHandle, 4, buffer, 4)) throw new Win32Exception(Marshal.GetLastWin32Error());
        } finally { Marshal.FreeHGlobal(buffer); }
    }
    static void RememberCleanupFailure(Exception primary, Exception cleanup, string temporary) {
        primary.Data["RetainTemporaryState"] = true;
        primary.Data["TemporaryFile"] = temporary;
        string previous = primary.Data["CleanupFailure"] as string;
        primary.Data["CleanupFailure"] = (previous == null ? "" : previous + "\n") + cleanup.ToString();
    }
    public static void Write(string destination, byte[] bytes) {
        WriteWithCleanup(destination, bytes, Erase);
    }
    // The production writer uses Erase; a private injectable cleanup boundary
    // lets native tests exercise a failed erasure after a REAL failed rename.
    static void WriteWithCleanup(string destination, byte[] bytes, Action<FileStream> erase) {
        string tmp = destination + "." + Guid.NewGuid().ToString("N") + ".tmp";
        var stream = Open(tmp, true);
        bool published = false;
        Exception primary = null;
        try {
            Check(stream); // descriptor of the acquired object, before bytes
            stream.Write(bytes, 0, bytes.Length);
            stream.Flush(true);
            Check(stream);
            Rename(stream, destination); // publish the acquired object itself
            published = true;
        } catch (Exception error) {
            primary = error;
            throw; // preserve the original exception and stack
        } finally {
            try {
                if (!published) erase(stream); // also handle-bound
            } catch (Exception cleanup) {
                if (primary == null) { primary = cleanup; throw; }
                RememberCleanupFailure(primary, cleanup, tmp);
            } finally {
                try { stream.Dispose(); }
                catch (Exception cleanup) {
                    if (primary == null) throw;
                    RememberCleanupFailure(primary, cleanup, published ? destination : tmp);
                }
            }
        }
    }
}
