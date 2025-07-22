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

import { authService } from './authService.js';
import { userModel, UserPublic } from '../models/userModel.js';
import * as crypto from 'crypto';

interface GitHubProfile {
  id: number;
  login: string;
  email?: string;
  name?: string;
  avatar_url?: string;
}

export class GitHubOAuthService {
  constructor() {
    // No parameters needed - will read from environment
  }

  private get clientId(): string | undefined {
    return process.env.GITHUB_CLIENT_ID;
  }

  private get clientSecret(): string | undefined {
    return process.env.GITHUB_CLIENT_SECRET;
  }

  private get callbackUrl(): string {
    return (
      process.env.GITHUB_CALLBACK_URL ||
      `${process.env.BASE_URL || 'http://localhost:3001'}/api/auth/oauth/github/callback`
    );
  }

  /**
   * Generate GitHub OAuth authorization URL
   */
  getAuthUrl(): string {
    if (!this.clientId) {
      throw new Error(
        'GitHub client ID not configured. Please set the GITHUB_CLIENT_ID environment variable.'
      );
    }

    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.callbackUrl,
      scope: 'user:email',
      response_type: 'code',
    });

    return `https://github.com/login/oauth/authorize?${params.toString()}`;
  }

  /**
   * Check if GitHub OAuth is configured
   */
  isConfigured(): boolean {
    return !!(this.clientId && this.clientSecret);
  }

  /**
   * Exchange authorization code for access token
   */
  async exchangeCodeForToken(code: string): Promise<string | null> {
    if (!this.clientId || !this.clientSecret) {
      console.error('GitHub OAuth credentials not configured');
      return null;
    }

    try {
      const response = await fetch(
        'https://github.com/login/oauth/access_token',
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            client_id: this.clientId,
            client_secret: this.clientSecret,
            code,
          }),
        }
      );

      const data = (await response.json()) as {
        access_token?: string;
        error?: string;
      };
      return data.access_token || null;
    } catch (error) {
      console.error('GitHub token exchange error:', error);
      return null;
    }
  }

  /**
   * Get GitHub user profile
   */
  async getUserProfile(accessToken: string): Promise<GitHubProfile | null> {
    try {
      const response = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `token ${accessToken}`,
          Accept: 'application/json',
        },
      });

      if (!response.ok) return null;

      const profile = (await response.json()) as GitHubProfile;

      // Get user's email if not public
      if (!profile.email) {
        const emailResponse = await fetch(
          'https://api.github.com/user/emails',
          {
            headers: {
              Authorization: `token ${accessToken}`,
              Accept: 'application/json',
            },
          }
        );

        if (emailResponse.ok) {
          const emails = (await emailResponse.json()) as {
            email: string;
            primary: boolean;
            verified: boolean;
          }[];
          const primaryEmail = emails.find(email => email.primary);
          if (primaryEmail) {
            profile.email = primaryEmail.email;
          }
        }
      }

      return profile;
    } catch (error) {
      console.error('GitHub profile fetch error:', error);
      return null;
    }
  }

  /**
   * Process GitHub OAuth callback
   */
  async processCallback(
    code: string
  ): Promise<{ user: UserPublic; token: string } | null> {
    try {
      // Exchange code for access token
      const accessToken = await this.exchangeCodeForToken(code);
      if (!accessToken) return null;

      // Get user profile
      const profile = await this.getUserProfile(accessToken);
      if (!profile) return null;

      // Create or find user
      const user = await this.createOrFindUser(profile);
      if (!user) return null;

      // Generate JWT token
      const jwtToken = authService.generateToken(user);

      return { user, token: jwtToken };
    } catch (error) {
      console.error('GitHub OAuth callback error:', error);
      return null;
    }
  }

  /**
   * Process user from GitHub profile (alias for createOrFindUser)
   */
  async processUser(profile: GitHubProfile): Promise<UserPublic | null> {
    return this.createOrFindUser(profile);
  }

  /**
   * Create or find user from GitHub profile
   */
  private async createOrFindUser(
    profile: GitHubProfile
  ): Promise<UserPublic | null> {
    try {
      // Create GitHub username with prefix
      let githubUsername = `gh_${profile.login || profile.id}`;

      // Check if user already exists
      const existingUser = userModel.getUserByUsername(githubUsername);

      if (existingUser) {
        console.log('Found existing GitHub user:', existingUser.username);
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

      // Ensure the username is unique
      let uniqueUsername = githubUsername;
      let counter = 1;
      while (userModel.usernameExists(uniqueUsername)) {
        uniqueUsername = `${githubUsername}_${counter}`;
        counter++;
      }

      // Create new user
      console.log('Creating new GitHub user:', uniqueUsername);

      const newUser = await userModel.createUser({
        username: uniqueUsername,
        email: profile.email || null,
        // Set a cryptographically secure random password since OAuth users don't use password login
        // The password is prefixed with 'oauth:' to mark this account as OAuth-only
        password: 'oauth:' + crypto.randomBytes(24).toString('base64'),
        role: 'user', // Default role
      });

      console.log('Created new GitHub user:', newUser.username);
      return newUser;
    } catch (error) {
      console.error('Error creating/finding GitHub user:', error);
      return null;
    }
  }
}

// Create singleton instance
export const githubOAuthService = new GitHubOAuthService();
