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
import React, { useEffect, useId, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Button } from './Button';
import { ModalShell } from './ModalShell';
import {
  currentConfirm,
  dismissAllConfirms,
  settle,
  subscribeToConfirm,
  type PendingConfirm,
} from './confirmStore';

/** Mount once near the app root; renders the foremost pending request. */
export const ConfirmDialogHost: React.FC = () => {
  const pending = useSyncExternalStore(
    subscribeToConfirm,
    currentConfirm,
    currentConfirm
  );
  const { pathname } = useLocation();
  // A prompt answers for the view that raised it; navigating away (including
  // sign-out) declines it rather than letting it act on a different page.
  useEffect(() => dismissAllConfirms, [pathname]);
  if (!pending) return null;
  // Key per request so focus handling restarts for each queued prompt.
  return <ConfirmDialogView key={pending.id} request={pending} />;
};

const ConfirmDialogView: React.FC<{ request: PendingConfirm }> = ({
  request,
}) => {
  const { t } = useTranslation();
  const titleId = useId();
  const confirmLabel =
    request.confirmLabel ??
    (request.destructive ? t('common.delete') : t('common.confirm'));

  return (
    <ModalShell
      titleId={titleId}
      title={request.title}
      subtitle={request.description}
      onClose={() => settle(false)}
      widthClassName='max-w-md'
      testId='confirm-dialog'
      footer={
        <>
          <Button
            type='button'
            variant='secondary'
            onClick={() => settle(false)}
            data-testid='confirm-dialog-cancel'
          >
            {request.cancelLabel ?? t('common.cancel')}
          </Button>
          <Button
            type='button'
            variant={request.destructive ? 'danger' : 'primary'}
            onClick={() => settle(true)}
            data-testid='confirm-dialog-confirm'
          >
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
};
