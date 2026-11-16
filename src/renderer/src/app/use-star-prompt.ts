import { useEffect, useRef, useState } from 'react';
import type { OnboardingSettings } from '@shared/onboarding';
import { PROJECT_URL, shouldShowStarPrompt } from '@shared/star-prompt';
import { openLink } from '../links';
import type { OnboardingChange } from './use-tips';

/** The time from the start of the app to the star notice, in milliseconds. It is shorter than the tip delay, so the tip waits. */
const NOTICE_DELAY_MS = 3000;

/** The time between two checks of the 5 days, in milliseconds. The window focus also starts a check. */
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

interface Options {
    onboarding: OnboardingSettings | undefined;
    settingsLoaded: boolean;
    /** True while another part of the window needs the attention of the user: the welcome page, the tour, or a dialog. */
    blocked: boolean;
    /** Returns true while another corner notice shows, for example a tip. The star notice waits. */
    busy(): boolean;
    saveOnboarding(change: OnboardingChange): Promise<void>;
    onError(err: unknown): void;
}

export interface StarNoticeState {
    /** Opens the GitHub page of ShipWarden and closes the notice for all time. */
    star(): void;
    /** Closes the notice for all time. */
    close(): void;
}

/**
 * The GitHub star notice. It shows one time, 5 days or more after the first use of the app.
 * While `blocked` is true or another corner notice shows, the notice waits.
 */
export function useStarPrompt({ onboarding, settingsLoaded, blocked, busy, saveOnboarding, onError }: Options): StarNoticeState | undefined {
    const [shown, setShown] = useState(false);
    /** True after the user answered the notice in this session. The saved value can arrive later than the next check. */
    const done = useRef(false);
    const latest = useRef({ onboarding, settingsLoaded, blocked, shown, busy });
    latest.current = { onboarding, settingsLoaded, blocked, shown, busy };
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    const ready = () => {
        const now = latest.current;
        if (done.current || !now.settingsLoaded || now.blocked || now.shown || now.busy()) return false;
        return shouldShowStarPrompt(now.onboarding, Date.now());
    };
    const check = () => {
        if (timer.current || !ready()) return;
        timer.current = setTimeout(() => {
            timer.current = undefined;
            // The state can change in the delay, for example the tour starts.
            if (ready()) setShown(true);
        }, NOTICE_DELAY_MS);
    };
    const checkRef = useRef(check);
    checkRef.current = check;

    // A check when the settings load and when the welcome page, the tour, or a dialog closes.
    // biome-ignore lint/correctness/useExhaustiveDependencies: checkRef gives the newest check.
    useEffect(() => {
        checkRef.current();
    }, [settingsLoaded, blocked]);

    // While the app stays open, a check each few minutes and at each focus of the window finds the end of the 5 days.
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

    if (!shown || blocked || done.current || onboarding?.starPromptDone) return undefined;
    const finish = () => {
        done.current = true;
        setShown(false);
        void saveOnboarding({ starPromptDone: true }).catch(onError);
    };
    return {
        star: () => {
            openLink(PROJECT_URL);
            finish();
        },
        close: finish
    };
}
