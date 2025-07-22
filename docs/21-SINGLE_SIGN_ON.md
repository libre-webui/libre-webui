---
sidebar_position: 21
title: "Single Sign-On (SSO)"
description: "Complete guide to configuring Single Sign-On (SSO) with GitHub and Hugging Face OAuth2 in Libre WebUI. Streamlined authentication for teams and organizations with enterprise-grade security."
slug: /SSO
keywords: [libre webui sso, github oauth, hugging face oauth, single sign on, oauth2 authentication, enterprise authentication, team authentication, github integration, hugging face integration, sso setup, oauth configuration, social login, hf oauth, ai authentication, developer login]
image: /img/social/21.png
---

# Single Sign-On (SSO) Integration

Libre WebUI supports enterprise-grade Single Sign-On (SSO) authentication through GitHub and Hugging Face OAuth2, enabling seamless authentication for teams and organizations while maintaining our commitment to privacy and security.

:::tip Quick Setup
**Get SSO working in 5 minutes!** 

**For GitHub OAuth:**
1. Create OAuth app at [GitHub Developer Settings](https://github.com/settings/developers)
2. Set callback URL: `http://localhost:3001/api/auth/oauth/github/callback`
3. Add `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` to your `.env`
4. Restart Libre WebUI

**For Hugging Face OAuth:**
1. Create OAuth app at [Hugging Face Applications](https://huggingface.co/settings/applications)
2. Set callback URL: `http://localhost:3001/api/auth/oauth/huggingface/callback`
3. Add `HUGGINGFACE_CLIENT_ID` and `HUGGINGFACE_CLIENT_SECRET` to your `.env`
4. Restart Libre WebUI

Both providers can be enabled simultaneously!
:::

:::info Enterprise Ready
🏢 **Team Authentication** - Seamless login for your entire organization  
🔐 **OAuth2 Security** - Industry-standard authentication protocol  
⚡ **Instant Setup** - Configure in minutes with environment variables  
🎯 **Multi-Provider Support** - GitHub and Hugging Face integration  
🤗 **AI Community** - Direct Hugging Face integration for AI developers  
🛡️ **Privacy First** - No data collection, tokens stored securely  
:::

## Overview

### Supported Providers
Currently supported SSO providers:

| Provider | Status | Protocol | Features |
|----------|--------|----------|----------|
| **GitHub** | ✅ Available | OAuth2 | Profile sync, team integration |
| **Hugging Face** | ✅ Available | OAuth2 | Profile sync, AI community integration |


### How SSO Works

1. **User Login**: Users click "Sign in with GitHub" or "Continue with Hugging Face" on the login page
2. **OAuth Flow**: Redirected to the chosen provider (GitHub/Hugging Face) for authentication
3. **Token Exchange**: Secure token exchange between Libre WebUI and the OAuth provider
4. **Account Creation**: Automatic account creation or linking for existing users
5. **JWT Token**: Users receive a secure JWT token for session management
6. **Profile Sync**: Provider profile information synced to local account

## GitHub OAuth2 Setup

### Step 1: Create GitHub OAuth App

1. Navigate to [GitHub Developer Settings](https://github.com/settings/developers)
2. Click **"New OAuth App"**
3. Fill in the application details:
   - **Application name**: `Libre WebUI - [Your Organization]`
   - **Homepage URL**: `http://localhost:5173` (or your domain)
   - **Authorization callback URL**: `http://localhost:3001/api/auth/oauth/github/callback`
4. Click **"Register application"**
5. Note down the **Client ID** and **Client Secret**

### Step 2: Configure Environment Variables

Add the following environment variables to your `.env` file:

```bash
# GitHub OAuth Configuration
GITHUB_CLIENT_ID=your_github_client_id_here
GITHUB_CLIENT_SECRET=your_github_client_secret_here
GITHUB_CALLBACK_URL=http://localhost:3001/api/auth/oauth/github/callback

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

## Hugging Face OAuth2 Setup

### Step 1: Create Hugging Face OAuth App

1. Navigate to [Hugging Face Application Settings](https://huggingface.co/settings/applications)
2. Click **"New application"**
3. Fill in the application details:
   - **Application name**: `Libre WebUI - [Your Organization]`
   - **Homepage URL**: `http://localhost:5173` (or your domain)
   - **Authorization callback URL**: `http://localhost:3001/api/auth/oauth/huggingface/callback`
   - **Application description**: `AI Chat Interface with Hugging Face Integration`
4. Click **"Create application"**
5. Note down the **Client ID** and **Client Secret**

:::warning Callback URL
Make sure the callback URL is exactly on port 3001: `http://localhost:3001/api/auth/oauth/huggingface/callback`

For production, use your domain: `https://your-domain.com/api/auth/oauth/huggingface/callback`
:::

### Step 2: Configure Environment Variables

Add the following environment variables to your `.env` file:

```bash
# Hugging Face OAuth Configuration
HUGGINGFACE_CLIENT_ID=your_huggingface_client_id_here
HUGGINGFACE_CLIENT_SECRET=your_huggingface_client_secret_here
HUGGINGFACE_CALLBACK_URL=http://localhost:3001/api/auth/oauth/huggingface/callback

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

### Step 4: Test Hugging Face SSO

1. Navigate to your Libre WebUI login page
2. You should see a **"Continue with Hugging Face"** button (orange colored)
3. Click the button to test the OAuth flow
4. Authorize the application on Hugging Face
5. You should be redirected back and automatically logged in

### Step 5: Verify Configuration

Test the Hugging Face OAuth status:

```bash
# Check if Hugging Face OAuth is configured
curl http://localhost:3001/api/auth/oauth/huggingface/status

# Should return: {"configured": true}
```

## Configuration Options

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GITHUB_CLIENT_ID` | ❌ No | - | GitHub OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | ❌ No | - | GitHub OAuth app client secret |
| `GITHUB_CALLBACK_URL` | ❌ No | auto | OAuth callback URL for GitHub |
| `HUGGINGFACE_CLIENT_ID` | ❌ No | - | Hugging Face OAuth app client ID |
| `HUGGINGFACE_CLIENT_SECRET` | ❌ No | - | Hugging Face OAuth app client secret |
| `HUGGINGFACE_CALLBACK_URL` | ❌ No | auto | OAuth callback URL for Hugging Face |
| `OAUTH_AUTO_REGISTER` | ❌ No | `true` | Auto-create accounts for new users |
| `OAUTH_DEFAULT_ROLE` | ❌ No | `user` | Default role for new OAuth users |
| `OAUTH_ALLOWED_DOMAINS` | ❌ No | - | Comma-separated list of allowed email domains |
| `OAUTH_ADMIN_USERS` | ❌ No | - | Comma-separated list of usernames to grant admin access |

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
GITHUB_CALLBACK_URL=https://ai.yourcompany.com/api/auth/oauth/github/callback
```

## User Experience

### Login Flow
1. **Login Page**: Users see traditional login plus OAuth options ("Sign in with GitHub", "Continue with Hugging Face")
2. **Provider Selection**: Users choose their preferred OAuth provider
3. **Provider Authorization**: Redirected to chosen provider (GitHub/Hugging Face) for secure authentication
4. **Permission Consent**: Provider requests permission to access basic profile information
5. **Account Linking**: 
   - **New Users**: Automatically creates account with provider profile information
   - **Existing Users**: Links provider profile to existing local account
6. **Dashboard Access**: Immediately redirected to Libre WebUI dashboard

### Profile Management
- **Provider Profile Sync**: Username, avatar, and email automatically synced from chosen provider
- **Multi-Provider Support**: Users can link multiple OAuth providers to one account
- **Hybrid Authentication**: Users can still use traditional password login
- **Profile Completion**: Users can add additional information after OAuth login
- **Account Security**: Provider account security policies apply

### User Interface Features
- **Provider Avatars**: Profile pictures automatically imported from GitHub/Hugging Face
- **Username Mapping**: 
  - GitHub usernames prefixed with `gh_` (e.g., `gh_username`)
  - Hugging Face usernames prefixed with `hf_` (e.g., `hf_username`)
- **Provider Indication**: Clear indication of authentication method used (GitHub 🐙, Hugging Face 🤗)
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

#### "OAuth button not appearing"
**Solution**: Verify environment variables are set correctly for your chosen provider:

For GitHub:
```bash
# Check if GitHub variables are loaded
echo $GITHUB_CLIENT_ID
echo $GITHUB_CLIENT_SECRET
```

For Hugging Face:
```bash
# Check if Hugging Face variables are loaded
echo $HUGGINGFACE_CLIENT_ID
echo $HUGGINGFACE_CLIENT_SECRET
```

#### "OAuth callback failed"
**Possible causes**:
- Incorrect callback URL in OAuth app settings
- Firewall blocking the callback port
- Environment variables not loaded

**Solution**:
1. Verify callback URL matches exactly:
   - GitHub: `http://localhost:8080/api/auth/oauth/github/callback`
   - Hugging Face: `http://localhost:8080/api/auth/oauth/huggingface/callback`
2. Check firewall settings allow port 8080
3. Restart Libre WebUI after changing environment variables

#### "Authentication failed - Please try again"
**Possible causes**:
- Invalid client secret
- Network connectivity issues
- Provider service outage

**Solution**:
1. Verify client secret is correct and not expired
2. Check network connectivity to the OAuth provider
3. Try again or check provider status page

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
GITHUB_CALLBACK_URL=https://your-domain.com/api/auth/oauth/github/callback
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
# GET /api/auth/oauth/github/status
curl http://localhost:8080/api/auth/oauth/github/status

# GET /api/auth/oauth/huggingface/status  
curl http://localhost:8080/api/auth/oauth/huggingface/status
```

**Response**:
```json
{
  "configured": true
}
```

### User Profile Endpoint
Get OAuth profile information:

```bash
# GET /api/oauth/profile
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     http://localhost:8080/api/oauth/profile
```

**Response for GitHub**:
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

**Response for Hugging Face**:
```json
{
  "success": true,
  "profile": {
    "provider": "huggingface",
    "huggingfaceId": "username",
    "username": "hf_username",
    "avatarUrl": "https://cdn-avatars.huggingface.co/v1/production/uploads/..."
  }
}
```

## Future Enhancements

### Planned Features
- **Google OAuth**: Google Workspace integration
- **Microsoft OAuth**: Azure AD and Office 365 support
- **SAML Support**: Enterprise identity provider integration
- **Team Synchronization**: Provider team/organization role mapping
- **Advanced Role Mapping**: Custom role assignment rules
- **Multi-Provider Linking**: Link multiple OAuth providers to one account
- **Provider-Specific Features**: Hugging Face model access, GitHub repository integration

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
