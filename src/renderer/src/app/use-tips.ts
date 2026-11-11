import { useEffect, useRef, useState } from 'react';
import type { OnboardingSettings } from '@shared/onboarding';
import { closeInlineTip, inlineTipShows, NOTICE_TIPS, pickTip, rememberTip, shouldShowTipNotice, type Tip, type TipAction } from '@shared/tips';
import type { TipsState } from '../components/Tips';

/** The time from the start of the app (or the end of the 12 hours) to the tip notice, in milliseconds. */
const NOTICE_DELAY_MS = 4000;

/** The time between two checks of the 12 hours, in milliseconds. The window focus also starts a check. */
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** A change of the onboarding state, or a function that makes the change from the newest state. */
export type OnboardingChange = Partial<OnboardingSettings> | ((current: OnboardingSettings | undefined) => Partial<OnboardingSettings>);

interface Options {
    onboarding: OnboardingSettings | undefined;
    settingsLoaded: boolean;
    /** True while another part of the window needs the attention of the user: the welcome page, the tour, or a dialog. */
    blocked: boolean;
    saveOnboarding(change: OnboardingChange): Promise<void>;
    runAction(action: TipAction): void;
    onError(err: unknown): void;
}

export interface TipNoticeState {
    tip: Tip;
    close(): void;
    turnOff(): void;
}

/**
 * The tips: the corner notice and the inline tips in the views.
 * The corner notice shows one random tip at each start of the app. While the app stays open, it shows a new tip 12 hours
 * after the user closed the last one. While `blocked` is true, the notice waits.
 */
export function useTips({ onboarding, settingsLoaded, blocked, saveOnboarding, runAction, onError }: Options): {
    notice: TipNoticeState | undefined;
    inline: TipsState;
} {
    const [index, setIndex] = useState<number>();
    /** True until the notice shows its tip of this app start. */
    const appStart = useRef(true);
    /** The time of the last close in this session. The saved value can arrive later than the next check. */
    const closedAt = useRef<number | undefined>(undefined);
    const latest = useRef({ onboarding, settingsLoaded, blocked, index });
    latest.current = { onboarding, settingsLoaded, blocked, index };
    const save = (change: OnboardingChange) => void saveOnboarding(change).catch(onError);
    const saveRef = useRef(save);
    saveRef.current = save;
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    const ready = () => {
        const now = latest.current;
        if (!now.settingsLoaded || now.blocked || now.index !== undefined || !now.onboarding) return false;
        const tipClosedAt = Math.max(now.onboarding.tipClosedAt ?? 0, closedAt.current ?? 0) || undefined;
        return shouldShowTipNotice({ ...now.onboarding, tipClosedAt }, appStart.current, Date.now());
    };
    const check = () => {
        if (timer.current || !ready()) return;
        timer.current = setTimeout(() => {
            timer.current = undefined;
            // The state can change in the delay, for example the tour starts.
            if (!ready()) return;
            const next = pickTip(latest.current.onboarding?.recentTips);
            appStart.current = false;
            setIndex(next);
            saveRef.current(current => ({ recentTips: rememberTip(current?.recentTips, NOTICE_TIPS[next].id) }));
        }, NOTICE_DELAY_MS);
    };
    const checkRef = useRef(check);
    checkRef.current = check;

    // A check when the settings load and when the welcome page, the tour, or a dialog closes.
    // biome-ignore lint/correctness/useExhaustiveDependencies: checkRef gives the newest check.
    useEffect(() => {
        checkRef.current();
    }, [settingsLoaded, blocked]);

    // While the app stays open, a check each few minutes and at each focus of the window finds the end of the 12 hours.
    useEffect(() => {
        const run = () => checkRef.current();
        const interval = setInterval(run, CHECK_INTERVAL_MS);
        window.addEventListener('focus', run);
        return () => {
            clearInterval(interval);
            window.removeEventListener('focus', run);
            if (timer.current) clearTimeout(timer.current);
            timer.current = undefined;
        };
    }, []);

    const notice: TipNoticeState | undefined =
        index === undefined || !onboarding || onboarding.tipsOff || blocked
            ? undefined
            : {
                  tip: NOTICE_TIPS[index],
                  close: () => {
                      const now = Date.now();
                      closedAt.current = now;
                      setIndex(undefined);
                      save({ tipClosedAt: now });
                  },
                  turnOff: () => {
                      setIndex(undefined);
                      save({ tipsOff: true });
                  }
              };

    const inline: TipsState = {
        shows: id => settingsLoaded && inlineTipShows(onboarding, id),
        close: id => save(current => ({ tipsClosed: closeInlineTip(current?.tipsClosed, id) })),
        run: runAction
    };

    return { notice, inline };
}
