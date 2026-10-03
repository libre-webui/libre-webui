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

import { useTranslation } from 'react-i18next';
import { AvatarUpload } from '@/components/AvatarUpload';
import { Button } from '@/components/ui/Button';
import { ModalShell } from '@/components/ui/ModalShell';

interface AvatarModalProps {
  open: boolean;
  value: string;
  saving: boolean;
  onChange: (value: string) => void;
  onClose: () => void;
  onSave: () => void;
}

export function AvatarModal({
  open,
  value,
  saving,
  onChange,
  onClose,
  onSave,
}: AvatarModalProps) {
  const { t } = useTranslation();

  if (!open) return null;

  return (
    <ModalShell
      titleId='avatar-modal-title'
      title={t('user.avatar.title')}
      widthClassName='max-w-md'
      onClose={onClose}
      footer={
        <>
          <Button type='button' variant='ghost' onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type='button' onClick={onSave} disabled={saving}>
            {saving ? t('common.saving') : t('common.save')}
          </Button>
        </>
      }
    >
      <AvatarUpload value={value} onChange={onChange} />
    </ModalShell>
  );
}
