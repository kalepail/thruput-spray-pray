/**
 * Chooses each transfer's expiry height so no sender's replay cache overflows.
 *
 * A sender's replay cache accepts at most 8,000 unexpired nonces per expiry height
 * (`kReplayCacheNoncesMaxLen`); more fail as a two-phase-commit capacity conflict that
 * Futurenet reports as `retry`. Resending cannot help, because the height stays full
 * until it expires. Each sender therefore fills one height up to `perHeight`, then
 * moves to the next, and never returns to a height it already used. Every new block
 * opens one more height inside the window, which bounds the sustained rate at about
 * `perHeight` transfers per sender per block.
 */
export interface ExpiryOptions {
  /** Blocks between the chain tip and the earliest expiry. */
  ahead: bigint;
  /** Heights past `ahead` that may be used before waiting for new blocks. */
  window: bigint;
  /** Nonces per sender per height; keep below the protocol's 8,000. */
  perHeight: number;
  /** Shards sharing a sender take every `slots`-th height, starting at `slot`. */
  slot: number;
  slots: number;
  /** The last height this shard used for `sender` before a restart, if known. */
  resume?: (sender: number) => bigint | undefined;
  /** Called when a sender starts a new height, so a restart can resume after it. */
  onHeight?: (sender: number, height: bigint) => void;
}

export function expiryAllocator(options: ExpiryOptions) {
  const slots = BigInt(options.slots);
  const slot = BigInt(options.slot);
  const cursors = new Map<number, { height: bigint; used: number }>();
  /** The smallest height at or above `height` that belongs to this shard. */
  const align = (height: bigint) =>
    height + ((((slot - (height % slots)) % slots) + slots) % slots);
  return {
    /** The next expiry for `sender`, or undefined until the tip advances. */
    next(sender: number, tip: bigint): bigint | undefined {
      const floor = align(tip + options.ahead);
      let cursor = cursors.get(sender);
      if (!cursor) {
        // After a restart, the previous instance's last height may still be filling.
        const resumed = options.resume?.(sender);
        // A stored height past the usable window means the chain was reset (a fresh
        // local node or a Futurenet wipe); waiting for it would stall forever.
        if (
          resumed !== undefined &&
          resumed + slots > floor &&
          resumed <= tip + options.ahead + options.window
        )
          cursor = { height: resumed, used: options.perHeight };
        else {
          cursor = { height: floor, used: 0 };
          options.onHeight?.(sender, floor);
        }
        cursors.set(sender, cursor);
      } else if (cursor.height < floor) {
        cursor.height = floor;
        cursor.used = 0;
        options.onHeight?.(sender, floor);
      }
      if (cursor.used >= options.perHeight) {
        if (cursor.height + slots > tip + options.ahead + options.window)
          return undefined;
        cursor.height += slots;
        cursor.used = 0;
        options.onHeight?.(sender, cursor.height);
      }
      cursor.used++;
      return cursor.height;
    },
  };
}
