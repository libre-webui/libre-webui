/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at:
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import React, {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  currentAnnouncements,
  subscribeToAnnouncer,
  type Announcement,
} from './liveAnnouncerStore';
// Clearing first and writing on a later tick makes a repeated identical
// message register as a change, so it is read again.
const WRITE_DELAY_MS = 50;
// Left in place, old text would be found again by browse-mode reading.
const CLEAR_AFTER_MS = 10_000;
const AnnouncerRegion: React.FC<{
  announcement: Announcement;
  politeness: 'polite' | 'assertive';
  testId: string;
}> = ({ announcement, politeness, testId }) => {
  const [text, setText] = useState('');
  // Whatever was said before this region mounted is not news.
  const seenId = useRef(announcement.id);
  useEffect(() => {
    if (announcement.id === seenId.current) return;
    seenId.current = announcement.id;
    setText('');
    const write = window.setTimeout(
      () => setText(announcement.message),
      WRITE_DELAY_MS
    );
    const clear = window.setTimeout(
      () => setText(''),
      WRITE_DELAY_MS + CLEAR_AFTER_MS
    );
    return () => {
      window.clearTimeout(write);
      window.clearTimeout(clear);
    };
  }, [announcement]);
  return (
    <div
      role={politeness === 'polite' ? 'status' : 'alert'}
      aria-live={politeness}
      aria-atomic='true'
      className='sr-only'
      data-testid={testId}
    >
      {text}
    </div>
  );
};
/** Mount once near the app root; speaks whatever `announce()` is given. */
export const LiveAnnouncerHost: React.FC = () => {
  const announcements = useSyncExternalStore(
    subscribeToAnnouncer,
    currentAnnouncements,
    currentAnnouncements
  );
  return (
    <>
      <AnnouncerRegion
        announcement={announcements.polite}
        politeness='polite'
        testId='live-announcer-polite'
      />
      <AnnouncerRegion
        announcement={announcements.assertive}
        politeness='assertive'
        testId='live-announcer-assertive'
      />
    </>
  );
};
