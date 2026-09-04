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

import React, { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';

interface UserManagementPageProps {
  /** Opens Settings on the User Management tab. */
  onOpen: () => void;
}

/**
 * User Management lives in Settings now. This route keeps every existing
 * link (sidebar shortcut, pending-approval badge, bookmarks) working by
 * opening that tab and stepping back to the home tab underneath it.
 */
export const UserManagementPage: React.FC<UserManagementPageProps> = ({
  onOpen,
}) => {
  const navigate = useNavigate();
  const openRef = useRef(onOpen);
  useEffect(() => {
    openRef.current = onOpen;
  }, [onOpen]);
  useEffect(() => {
    openRef.current();
    navigate('/', { replace: true });
  }, [navigate]);
  return null;
};

export default UserManagementPage;
