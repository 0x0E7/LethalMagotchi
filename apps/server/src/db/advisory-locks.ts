/**
 * Every process-wide "only one instance may do this" gate contends for a key from here.
 * Boot-time recovery sweeps rewrite state that another live instance may still own, so
 * each one needs its own key rather than sharing the scheduler's.
 */
export const SCHEDULER_LOCK_KEY = 0x4c4d_5431;
export const DUEL_RECOVERY_LOCK_KEY = 0x4c4d_5432;
export const RAID_RECOVERY_LOCK_KEY = 0x4c4d_5433;
