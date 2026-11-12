using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;

namespace TerminalGridIntegrated
{
    internal sealed class PaneState
    {
        public string WorkspaceId, TabId, RouteId;
        public int Slot, Generation, InFlight;
        public PtySession Session;
        public ShellCommand Command;
        public BlockingCollection<byte[]> Output = new BlockingCollection<byte[]>(256);
        public bool Starting, Stopping, ExitSent;
        public int? ExitCode;
    }
    internal sealed class PaneAddress
    {
        public string workspaceId { get; set; }
        public int slot { get; set; }
        public string tabId { get; set; }
        public string Key { get { return PaneRelocation.Key(workspaceId, slot, tabId); } }
    }
    internal sealed class PaneMove
    {
        public PaneAddress from { get; set; }
        public PaneAddress to { get; set; }
    }
    internal static class PaneRelocation
    {
        public static string Key(string workspace, int slot, string tab) { return workspace + ":" + slot + ":" + tab; }
        static bool Exists(AppConfig config, PaneAddress address)
        {
            if (address == null || address.slot < 0 || address.slot >= 16) return false;
            var workspace = config.workspaces.FirstOrDefault(w => w.id == address.workspaceId);
            return workspace != null && workspace.slots[address.slot].tabs.Any(t => t.id == address.tabId);
        }
        public static void Apply(Dictionary<string, PaneState> states, AppConfig before, AppConfig after, PaneMove[] moves, Action save)
        {
            if (moves == null || moves.Length == 0 || moves.Length > 16) throw new ArgumentException("移動項目不正確。");
            var sources = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var targets = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var move in moves) {
                if (move == null || !Exists(before, move.from) || !Exists(after, move.to) || !sources.Add(move.from.Key) || !targets.Add(move.to.Key))
                    throw new ArgumentException("來源或目標分頁已變更，請重試。");
            }
            var next = new Dictionary<string, PaneState>(states, StringComparer.OrdinalIgnoreCase);
            foreach (var move in moves) next.Remove(move.from.Key);
            foreach (var move in moves) {
                PaneState state, collision;
                states.TryGetValue(move.from.Key, out state);
                if (state != null && (state.Starting || state.Stopping)) throw new InvalidOperationException("請等終端啟動或停止完成再移動。");
                if (next.TryGetValue(move.to.Key, out collision) && (collision.Session != null || collision.Starting || collision.Stopping))
                    throw new InvalidOperationException("目標仍有執行中的終端。");
                next.Remove(move.to.Key);
                if (state != null) next.Add(move.to.Key, state);
            }
            // Persist first: a failed write must leave every live route untouched.
            save();
            foreach (var move in moves) {
                PaneState state;
                if (states.TryGetValue(move.from.Key, out state)) { state.WorkspaceId = move.to.workspaceId; state.Slot = move.to.slot; state.TabId = move.to.tabId; }
            }
            states.Clear(); foreach (var item in next) states.Add(item.Key, item.Value);
        }
    }
}
