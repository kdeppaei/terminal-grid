using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace TerminalGridIntegrated
{
    public static class FolderPicker
    {
        const int Cancelled = unchecked((int)0x800704C7);
        const int ClassNotRegistered = unchecked((int)0x80040154);
        const int NoInterface = unchecked((int)0x80004002);
        const uint FileSystemPath = 0x80058000;
        const uint PickFolders = 0x20, ForceFileSystem = 0x40, PathMustExist = 0x800;
        const uint NoChangeDirectory = 0x8, DontAddToRecent = 0x02000000;

        // Keep literal paths (including names such as %TEMP%) intact. Typed environment
        // variables remain useful when no such literal directory exists.
        public static string InitialFolder(string initialPath)
        {
            string candidate = initialPath ?? "";
            string existing = ExistingFolder(candidate);
            if (existing != null) return existing;
            if (!String.IsNullOrWhiteSpace(candidate))
            {
                // If the saved path was removed, first honor its literal parent.
                // A directory name may legitimately contain text such as %NAME%.
                existing = ExistingParent(candidate);
                if (existing != null) return existing;
                candidate = Environment.ExpandEnvironmentVariables(candidate.Trim());
                existing = ExistingFolder(candidate) ?? ExistingParent(candidate);
                if (existing != null) return existing;
            }
            // A saved folder may have been removed or its drive disconnected.
            // The picker must still let the user choose a replacement.
            existing = ExistingFolder(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile))
                ?? ExistingFolder(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments))
                ?? ExistingFolder(Environment.SystemDirectory);
            if (existing == null) throw new DirectoryNotFoundException("找不到可用的起始資料夾。");
            return existing;
        }

        static string ExistingFolder(string path)
        {
            if (String.IsNullOrWhiteSpace(path) || !Directory.Exists(path)) return null;
            try { return Path.GetFullPath(path); }
            catch (ArgumentException) { return null; }
            catch (NotSupportedException) { return null; }
            catch (IOException) { return null; }
            catch (UnauthorizedAccessException) { return null; }
            catch (System.Security.SecurityException) { return null; }
        }

        static string ExistingParent(string path)
        {
            try
            {
                string candidate = Path.GetFullPath(path);
                while (!String.IsNullOrEmpty(candidate))
                {
                    string parent = Path.GetDirectoryName(candidate);
                    if (parent == candidate) break;
                    candidate = parent;
                    string existing = ExistingFolder(candidate);
                    if (existing != null) return existing;
                }
            }
            catch (ArgumentException) { }
            catch (NotSupportedException) { }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            catch (System.Security.SecurityException) { }
            return null;
        }

        public static string Pick(IWin32Window owner, string initialPath)
        {
            if (Thread.CurrentThread.GetApartmentState() != ApartmentState.STA)
                throw new InvalidOperationException("選擇資料夾必須在主視窗執行緒執行。");
            string folder = InitialFolder(initialPath);
            IFileOpenDialog dialog;
            // Only COM activation failure may use the older system picker. Errors
            // navigating or selecting a path must remain visible to the user.
            try { dialog = (IFileOpenDialog)new FileOpenDialog(); }
            catch (COMException ex)
            {
                if (ex.ErrorCode != ClassNotRegistered && ex.ErrorCode != NoInterface) throw;
                return PickLegacy(owner, folder);
            }
            IShellItem initial = null, selected = null;
            IntPtr displayName = IntPtr.Zero;
            try
            {
                uint options; dialog.GetOptions(out options);
                dialog.SetOptions(options | PickFolders | ForceFileSystem | PathMustExist | NoChangeDirectory | DontAddToRecent);
                dialog.SetTitle("選擇此格的工作資料夾");
                dialog.SetOkButtonLabel("選擇資料夾");
                Guid shellItemId = typeof(IShellItem).GUID;
                Marshal.ThrowExceptionForHR(SHCreateItemFromParsingName(folder, IntPtr.Zero, ref shellItemId, out initial));
                // Each pane opens at its configured directory instead of another
                // pane's most recently visited location.
                dialog.SetFolder(initial);
                int result = dialog.Show(owner == null ? IntPtr.Zero : owner.Handle);
                if (result == Cancelled) return null;
                Marshal.ThrowExceptionForHR(result);
                dialog.GetResult(out selected);
                selected.GetDisplayName(FileSystemPath, out displayName);
                string path = Marshal.PtrToStringUni(displayName);
                if (String.IsNullOrEmpty(path) || !Directory.Exists(path))
                    throw new DirectoryNotFoundException("選擇的工作資料夾不存在或無法存取。");
                return path;
            }
            finally
            {
                if (displayName != IntPtr.Zero) Marshal.FreeCoTaskMem(displayName);
                Release(selected); Release(initial); Release(dialog);
            }
        }

        static string PickLegacy(IWin32Window owner, string initialPath)
        {
            using (FolderBrowserDialog dialog = new FolderBrowserDialog
            {
                Description = "選擇此格的工作資料夾",
                SelectedPath = initialPath,
                ShowNewFolderButton = false
            })
            {
                if (dialog.ShowDialog(owner) != DialogResult.OK) return null;
                if (!Directory.Exists(dialog.SelectedPath))
                    throw new DirectoryNotFoundException("選擇的工作資料夾不存在或無法存取。");
                return dialog.SelectedPath;
            }
        }

        static void Release(object value)
        {
            if (value != null && Marshal.IsComObject(value)) Marshal.FinalReleaseComObject(value);
        }

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
        static extern int SHCreateItemFromParsingName([MarshalAs(UnmanagedType.LPWStr)] string path,
            IntPtr bindingContext, ref Guid interfaceId, [MarshalAs(UnmanagedType.Interface)] out IShellItem item);

        [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
        class FileOpenDialog { }

        // Flatten IModalWindow and IFileDialog before the two IFileOpenDialog
        // members so the native COM vtable order is preserved.
        [ComImport, Guid("D57C7288-D4AD-4768-BE02-9D969532D960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IFileOpenDialog
        {
            [PreserveSig] int Show(IntPtr owner);
            void SetFileTypes(uint count, IntPtr filters);
            void SetFileTypeIndex(uint index);
            void GetFileTypeIndex(out uint index);
            void Advise(IntPtr events, out uint cookie);
            void Unadvise(uint cookie);
            void SetOptions(uint options);
            void GetOptions(out uint options);
            void SetDefaultFolder([MarshalAs(UnmanagedType.Interface)] IShellItem folder);
            void SetFolder([MarshalAs(UnmanagedType.Interface)] IShellItem folder);
            void GetFolder([MarshalAs(UnmanagedType.Interface)] out IShellItem folder);
            void GetCurrentSelection([MarshalAs(UnmanagedType.Interface)] out IShellItem item);
            void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
            void GetFileName(out IntPtr name);
            void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
            void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
            void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
            void GetResult([MarshalAs(UnmanagedType.Interface)] out IShellItem item);
            void AddPlace([MarshalAs(UnmanagedType.Interface)] IShellItem item, int alignment);
            void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
            void Close(int result);
            void SetClientGuid(ref Guid guid);
            void ClearClientData();
            void SetFilter(IntPtr filter);
            void GetResults(out IntPtr results);
            void GetSelectedItems(out IntPtr selectedItems);
        }

        [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IShellItem
        {
            void BindToHandler(IntPtr bindingContext, ref Guid handlerId, ref Guid interfaceId, out IntPtr value);
            void GetParent([MarshalAs(UnmanagedType.Interface)] out IShellItem parent);
            void GetDisplayName(uint format, out IntPtr name);
            void GetAttributes(uint mask, out uint attributes);
            void Compare([MarshalAs(UnmanagedType.Interface)] IShellItem item, uint hint, out int order);
        }
    }
}
