---
sidebar_position: 21
title: "Single Sign-On (SSO)"
description: "Complete guide to configuring Single Sign-On (SSO) with GitHub OAuth2 in Libre WebUI. Streamlined authentication for teams and organizations with enterprise-grade security."
slug: /SSO
keywords: [libre webui sso, github oauth, single sign on, oauth2 authentication, enterprise authentication, team authentication, github integration, sso setup, oauth configuration, social login]
image: /img/social/21.png
---

# Single Sign-On (SSO) Integration

Libre WebUI supports enterprise-grade Single Sign-On (SSO) authentication through GitHub OAuth2, enabling seamless authentication for teams and organizations while maintaining our commitment to privacy and security.

:::tip Quick Setup
**Get SSO working in 5 minutes!** Follow our step-by-step setup guide below to enable GitHub OAuth2 authentication for your team.
:::

:::info Enterprise Ready
🏢 **Team Authentication** - Seamless login for your entire organization  
🔐 **OAuth2 Security** - Industry-standard authentication protocol  
⚡ **Instant Setup** - Configure in minutes with environment variables  
🎯 **GitHub Integration** - Leverage existing GitHub accounts  
🛡️ **Privacy First** - No data collection, tokens stored securely  
:::

## Overview

### Supported Providers
Currently supported SSO providers:

| Provider | Status | Protocol | Features |
|----------|--------|----------|----------|
| **GitHub** | ✅ Available | OAuth2 | Profile sync, team integration |
| **Google** | 🔄 Planned | OAuth2 | Gmail integration, G Suite support |
| **Microsoft** | 🔄 Planned | OAuth2 | Azure AD, Office 365 integration |
| **SAML** | 🔄 Planned | SAML 2.0 | Enterprise identity providers |

### How SSO Works

1. **User Login**: Users click "Sign in with GitHub" on the login page
2. **OAuth Flow**: Redirected to GitHub for authentication
3. **Token Exchange**: Secure token exchange between Libre WebUI and GitHub
4. **Account Creation**: Automatic account creation or linking for existing users
5. **JWT Token**: Users receive a secure JWT token for session management
6. **Profile Sync**: GitHub profile information synced to local account

## GitHub OAuth2 Setup

### Step 1: Create GitHub OAuth App

1. Navigate to [GitHub Developer Settings](https://github.com/settings/developers)
2. Click **"New OAuth App"**
3. Fill in the application details:
   - **Application name**: `Libre WebUI - [Your Organization]`
   - **Homepage URL**: `http://localhost:3000` (or your domain)
   - **Authorization callback URL**: `http://localhost:3001/auth/github/callback`
4. Click **"Register application"**
5. Note down the **Client ID** and **Client Secret**

### Step 2: Configure Environment Variables

Add the following environment variables to your `.env` file:

```bash
# GitHub OAuth Configuration
GITHUB_CLIENT_ID=your_github_client_id_here
GITHUB_CLIENT_SECRET=your_github_client_secret_here
GITHUB_CALLBACK_URL=http://localhost:3001/auth/github/callback

# Optional: Customize OAuth behavior
OAUTH_AUTO_REGISTER=true
OAUTH_DEFAULT_ROLE=user
```

### Step 3: Restart Libre WebUI

```bash
# Docker Compose
docker-compose restart

# Or for npm/development
npm run dev
```

### Step 4: Test SSO Login

1. Navigate to your Libre WebUI login page
2. You should see a **"Sign in with GitHub"** button
3. Click the button to test the OAuth flow
4. Authorize the application on GitHub
5. You should be redirected back and automatically logged in

## Configuration Options

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GITHUB_CLIENT_ID` | ✅ Yes | - | GitHub OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | ✅ Yes | - | GitHub OAuth app client secret |
| `GITHUB_CALLBACK_URL` | ✅ Yes | - | OAuth callback URL |
| `OAUTH_AUTO_REGISTER` | ❌ No | `true` | Auto-create accounts for new users |
| `OAUTH_DEFAULT_ROLE` | ❌ No | `user` | Default role for new OAuth users |
| `OAUTH_ALLOWED_DOMAINS` | ❌ No | - | Comma-separated list of allowed email domains |
| `OAUTH_ADMIN_USERS` | ❌ No | - | Comma-separated list of GitHub usernames to grant admin access |

### Advanced Configuration

#### Domain Restrictions
Restrict SSO access to specific email domains:

```bash
# Only allow users with company email domains
OAUTH_ALLOWED_DOMAINS=company.com,enterprise.org
```

#### Admin User Assignment
Automatically grant admin privileges to specific GitHub users:

```bash
# Grant admin access to specific GitHub usernames
OAUTH_ADMIN_USERS=ceo-username,cto-username,admin-user
```

#### Custom Callback URLs
For production deployments with custom domains:

```bash
# Production callback URL
GITHUB_CALLBACK_URL=https://ai.yourcompany.com/auth/github/callback
```

## User Experience

### Login Flow
1. **Login Page**: Users see both traditional login and "Sign in with GitHub" option
2. **GitHub Authorization**: Redirected to GitHub for secure authentication
3. **Permission Consent**: GitHub requests permission to access basic profile information
4. **Account Linking**: 
   - **New Users**: Automatically creates account with GitHub profile information
   - **Existing Users**: Links GitHub profile to existing local account
5. **Dashboard Access**: Immediately redirected to Libre WebUI dashboard

### Profile Management
- **GitHub Profile Sync**: Username, avatar, and email automatically synced
- **Hybrid Authentication**: Users can still use traditional password login
- **Profile Completion**: Users can add additional information after OAuth login
- **Account Security**: GitHub account security policies apply

### User Interface Features
- **GitHub Avatar**: Profile pictures automatically imported from GitHub
- **Username Mapping**: GitHub usernames prefixed with `gh_` to avoid conflicts
- **Provider Indication**: Clear indication of authentication method used
- **Seamless Logout**: Single logout clears both local and OAuth sessions

## Security Considerations

### OAuth2 Security
- **Secure Token Storage**: OAuth tokens encrypted and stored securely
- **Token Refresh**: Automatic token refresh for long-lived sessions
- **Scope Limitation**: Minimal scope requests (only public profile access)
- **CSRF Protection**: State parameter validation prevents CSRF attacks

### Data Privacy
- **No Data Collection**: GitHub tokens used only for authentication
- **Local Storage**: All user data remains on your Libre WebUI instance
- **Minimal Permissions**: Only requests necessary profile information
- **Token Isolation**: GitHub tokens never shared with third parties

### Access Control
- **Role-Based Access**: OAuth users assigned roles like traditional users
- **Domain Validation**: Optional email domain verification
- **Admin Controls**: Manual admin assignment through environment variables
- **Account Linking**: Secure linking between OAuth and local accounts

## Troubleshooting

### Common Issues

#### "GitHub OAuth button not appearing"
**Solution**: Verify environment variables are set correctly:
```bash
# Check if variables are loaded
echo $GITHUB_CLIENT_ID
echo $GITHUB_CLIENT_SECRET
```

#### "OAuth callback failed"
**Possible causes**:
- Incorrect callback URL in GitHub OAuth app settings
- Firewall blocking the callback port
- Environment variables not loaded

**Solution**:
1. Verify callback URL matches exactly: `http://localhost:3001/auth/github/callback`
2. Check firewall settings allow port 3001
3. Restart Libre WebUI after changing environment variables

#### "Authentication failed - Please try again"
**Possible causes**:
- Invalid client secret
- Network connectivity issues
- GitHub service outage

**Solution**:
1. Verify client secret is correct and not expired
2. Check network connectivity to GitHub
3. Try again or check GitHub status page

#### "User not authorized"
**Possible causes**:
- Domain restrictions enabled (`OAUTH_ALLOWED_DOMAINS`)
- User's email doesn't match allowed domains
- Auto-registration disabled

**Solution**:
1. Check domain restrictions configuration
2. Verify user's GitHub email matches allowed domains
3. Enable `OAUTH_AUTO_REGISTER=true` if needed

### Debug Mode

Enable debug logging for OAuth troubleshooting:

```bash
# Add to .env file
DEBUG=oauth:*
LOG_LEVEL=debug
```

### Testing OAuth Flow

Test the OAuth configuration manually:

1. **Check OAuth App**: Verify GitHub OAuth app settings
2. **Environment Variables**: Confirm all required variables are set
3. **Network Access**: Ensure callback URL is accessible
4. **User Permissions**: Verify user meets any domain/role restrictions

## Production Deployment

### SSL/HTTPS Configuration
For production deployments, always use HTTPS:

```bash
# Production callback with HTTPS
GITHUB_CALLBACK_URL=https://your-domain.com/auth/github/callback
```

Update your GitHub OAuth app callback URL accordingly.

### Load Balancer Considerations
If using a load balancer:

1. **Sticky Sessions**: Configure sticky sessions for OAuth callbacks
2. **Health Checks**: Exclude OAuth endpoints from health check probes
3. **SSL Termination**: Ensure proper SSL termination configuration

### Security Best Practices

1. **Environment Variables**: Never commit OAuth secrets to version control
2. **Secret Rotation**: Regularly rotate GitHub OAuth app secrets
3. **Access Logging**: Enable OAuth access logging for security auditing
4. **Backup Strategy**: Include OAuth configuration in backup procedures

## Migration Guide

### From Basic Authentication
If migrating from username/password authentication:

1. **User Communication**: Notify users about new SSO option
2. **Parallel Authentication**: Both methods work simultaneously
3. **Account Linking**: Users can link GitHub accounts to existing accounts
4. **Gradual Rollout**: Enable SSO for test users first

### Account Linking Process
Existing users can link their GitHub accounts:

1. **Login with Password**: Use existing username/password
2. **Settings Page**: Navigate to account settings
3. **Link GitHub**: Click "Link GitHub Account" button
4. **OAuth Flow**: Complete GitHub authorization
5. **Confirmation**: Account successfully linked

## API Integration

### OAuth Status Endpoint
Check OAuth configuration status:

```bash
# GET /api/oauth/status
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     http://localhost:3001/api/oauth/status
```

**Response**:
```json
{
  "success": true,
  "providers": {
    "github": {
      "enabled": true,
      "configured": true
    }
  }
}
```

### User Profile Endpoint
Get OAuth profile information:

```bash
# GET /api/oauth/profile
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     http://localhost:3001/api/oauth/profile
```

**Response**:
```json
{
  "success": true,
  "profile": {
    "provider": "github",
    "githubId": "12345",
    "username": "gh_username",
    "avatarUrl": "https://avatars.githubusercontent.com/u/12345"
  }
}
```

## Future Enhancements

### Planned Features
- **Google OAuth**: Google Workspace integration
- **Microsoft OAuth**: Azure AD and Office 365 support
- **SAML Support**: Enterprise identity provider integration
- **Team Synchronization**: GitHub team/organization role mapping
- **Advanced Role Mapping**: Custom role assignment rules
- **Multi-Provider**: Support multiple OAuth providers simultaneously

### Community Contributions
We welcome community contributions for additional OAuth providers:

1. **Provider Requests**: Submit issues for desired OAuth providers
2. **Implementation Guide**: Follow our OAuth provider development guide
3. **Testing**: Help test new OAuth implementations
4. **Documentation**: Contribute to OAuth documentation

---

## Need Help?

:::tip Support Resources
- **📖 Documentation**: Complete guides and API references
- **💬 Community**: Join our community discussions
- **🐛 Issues**: Report bugs or request features on GitHub
- **📧 Support**: Enterprise support available
:::

For additional help with SSO configuration, please refer to our [Authentication Documentation](./AUTHENTICATION) or reach out to our community support channels.
