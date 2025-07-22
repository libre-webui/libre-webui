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

import { userModel, UserPublic } from '../models/userModel.js';
import * as crypto from 'crypto';

interface HuggingFaceProfile {
  id: string;
  name: string;
  fullname: string;
  email?: string;
  avatarUrl?: string;
  isPro?: boolean;
  orgs?: Array<{
    name: string;
    fullname: string;
    isEnterprise: boolean;
  }>;
}

export class HuggingFaceOAuthService {
  constructor() {
    // No parameters needed - will read from environment
  }

  private get clientId(): string | undefined {
    return process.env.HUGGINGFACE_CLIENT_ID;
  }

  private get clientSecret(): string | undefined {
    return process.env.HUGGINGFACE_CLIENT_SECRET;
  }

  private get callbackUrl(): string {
    return (
      process.env.HUGGINGFACE_CALLBACK_URL ||
      `${process.env.BASE_URL || 'http://localhost:3001'}/api/auth/oauth/huggingface/callback`
    );
  }

  /**
   * Check if Hugging Face OAuth is properly configured
   */
  isConfigured(): boolean {
    return !!(this.clientId && this.clientSecret);
  }

  /**
   * Generate the authorization URL for Hugging Face OAuth
   */
  getAuthUrl(): string {
    if (!this.clientId) {
      throw new Error(
        'Hugging Face Client ID not configured. Please set the HUGGINGFACE_CLIENT_ID environment variable.'
      );
    }

    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.callbackUrl,
      response_type: 'code',
      scope: 'read-repos read-billing', // Hugging Face scopes
      state: crypto.randomBytes(32).toString('hex'), // CSRF protection
    });

    const authUrl = `https://huggingface.co/oauth/authorize?${params.toString()}`;
    console.log('🤗 Hugging Face auth URL generated:', authUrl);
    return authUrl;
  }

  /**
   * Exchange authorization code for access token
   */
  async exchangeCodeForToken(code: string): Promise<string | null> {
    try {
      const response = await fetch('https://huggingface.co/oauth/token', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: this.clientId!,
          client_secret: this.clientSecret!,
          code,
          grant_type: 'authorization_code',
          redirect_uri: this.callbackUrl,
        }),
      });

      const data = (await response.json()) as {
        access_token?: string;
        error?: string;
      };
      return data.access_token || null;
    } catch (error) {
      console.error('Hugging Face token exchange error:', error);
      return null;
    }
  }

  /**
   * Get user profile from Hugging Face API
   */
  async getUserProfile(
    accessToken: string
  ): Promise<HuggingFaceProfile | null> {
    try {
      const response = await fetch('https://huggingface.co/api/whoami-v2', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        console.error('Failed to fetch Hugging Face profile:', response.status);
        return null;
      }

      const profile = (await response.json()) as HuggingFaceProfile;
      console.log('🤗 Hugging Face profile fetched:', profile.name);
      return profile;
    } catch (error) {
      console.error('Error fetching Hugging Face profile:', error);
      return null;
    }
  }

  /**
   * Process Hugging Face user and create/update local user
   */
  async processUser(profile: HuggingFaceProfile): Promise<UserPublic | null> {
    try {
      // Generate a unique username based on Hugging Face username
      let uniqueUsername = `hf_${profile.name}`;

      // Check if username already exists and make it unique if needed
      let counter = 1;
      let checkUsername = uniqueUsername;
      while (userModel.usernameExists(checkUsername)) {
        checkUsername = `${uniqueUsername}_${counter}`;
        counter++;
      }
      uniqueUsername = checkUsername;

      // Check if user already exists by username first (Hugging Face doesn't always provide email)
      const existingUser = userModel.getUserByUsername(`hf_${profile.name}`);
      if (existingUser) {
        console.log(
          'Found existing Hugging Face user by username:',
          existingUser.username
        );
        // Convert User to UserPublic format
        return {
          id: existingUser.id,
          username: existingUser.username,
          email: existingUser.email,
          role: existingUser.role,
          createdAt: new Date(existingUser.created_at).toISOString(),
          updatedAt: new Date(existingUser.updated_at).toISOString(),
        };
      }

      // Create new user
      console.log('Creating new Hugging Face user:', uniqueUsername);

      const newUser = await userModel.createUser({
        username: uniqueUsername,
        email: profile.email || null,
        // Set a cryptographically secure random password since OAuth users don't use password login
        // The password is prefixed with 'oauth:hf:' to mark this account as Hugging Face OAuth-only
        password: 'oauth:hf:' + crypto.randomBytes(24).toString('base64'),
        role: 'user', // Default role
      });

      console.log('Created new Hugging Face user:', newUser.username);
      return newUser;
    } catch (error) {
      console.error('Error creating/finding Hugging Face user:', error);
      return null;
    }
  }
}

// Export singleton instance
export const huggingFaceOAuthService = new HuggingFaceOAuthService();
