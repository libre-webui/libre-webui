---
sidebar_position: 1
title: "Authentication & Security"
description: "Advanced authentication and security in Libre WebUI. Comprehensive user management with role-based access control, JWT security, and privacy protection."
slug: /AUTHENTICATION
keywords: [libre webui authentication, secure ai interface, privacy-first authentication, role-based access control, jwt security, user management ai, secure local ai, open webui alternative security]
image: /img/social/12.png
---

# Libre WebUI Authentication System

This document describes the comprehensive authentication and user management system implemented in Libre WebUI.

## Default Admin User

### First-Time Setup Experience
When no users exist in the database, Libre WebUI presents a beautiful first-time setup wizard that guides users through creating the initial admin account. This setup experience:

- **Welcome Screen**: Introduces key features with an app-style interface
- **Admin Creation**: Secure form for creating the first administrator account
- **Automatic Admin Role**: The first user is automatically granted admin privileges
- **Consistent Design**: Matches the app's design system with proper light/dark mode support
- **Integrated Flow**: Seamlessly transitions into the main application after setup

### First-time Setup
1. On first startup, if no users exist, the first-time setup wizard is displayed
2. Users are guided through a welcome screen highlighting key features
3. The admin account creation form validates input and creates the first user
4. The first user is automatically assigned admin role and logged in
5. **Security**: Change the default password immediately after first login (if using environment defaults)ibre WebUI.

## Features

### Core Authentication
- JWT-based authentication with configurable expiration
- Secure password hashing using bcrypt (12 salt rounds)
- Rate limiting for login attempts (5 attempts per 15 minutes)
- Password strength validation
- Optional email-based authentication
- First-time setup wizard for admin account creation

### User Management
- Role-based access control (admin/user)
- Single-user mode configuration
- User CRUD operations (Create, Read, Update, Delete)
- Password change and reset functionality
- User statistics and system information

### Security Features
- Environment variable configuration
- CORS protection
- Helmet security headers
- Input validation and sanitization
- Protected endpoints with middleware
- Failed login attempt tracking

## Configuration

### Environment Variables (.env)

```env
# Authentication & User Management
SINGLE_USER_MODE=true              # Enable/disable multi-user features
JWT_SECRET=your-jwt-secret         # JWT signing secret (change in production)
JWT_EXPIRES_IN=7d                  # JWT token expiration
DEFAULT_ADMIN_USERNAME=admin       # Default admin username
DEFAULT_ADMIN_EMAIL=admin@localhost # Default admin email
DEFAULT_ADMIN_PASSWORD=admin123    # Default admin password (change after first login)
```

### Single User Mode

When `SINGLE_USER_MODE=true`:
- Only the default admin user can log in
- User registration is disabled
- User management endpoints are blocked
- Simplified authentication flow

When `SINGLE_USER_MODE=false`:
- Multi-user functionality enabled
- Users can register (if allowed)
- Admin can manage all users
- Full CRUD operations available

## API Endpoints

### Authentication Routes (`/api/auth`)

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| POST   | `/login` | User login | No |
| POST   | `/register` | User registration | No (disabled in single-user mode) |
| POST   | `/logout` | User logout | Yes |
| GET    | `/me` | Get current user info | Yes |
| POST   | `/change-password` | Change own password | Yes |
| POST   | `/reset-password` | Reset user password (admin only) | Yes (admin) |
| GET    | `/system-info` | Get system information | No |

### User Management Routes (`/api/users`)

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| GET    | `/` | List all users | Yes (admin, disabled in single-user mode) |
| GET    | `/:id` | Get user by ID | Yes (admin or own user) |
| POST   | `/` | Create new user | Yes (admin, disabled in single-user mode) |
| PUT    | `/:id` | Update user | Yes (admin or own user) |
| DELETE | `/:id` | Delete user | Yes (admin, disabled in single-user mode) |
| GET    | `/stats` | Get user statistics | Yes (admin) |

## Database Schema

### Users Table
```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'user',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

## Middleware

### Authentication Middleware
- `authenticateToken`: Validates JWT token
- `optionalAuth`: Optional authentication (sets user if token present)
- `requireRole(roles...)`: Requires specific role(s)
- `requireAdmin`: Requires admin role
- `rateLimitAuth`: Rate limits authentication attempts

### Authorization Middleware
- `checkSingleUserMode`: Blocks endpoints in single-user mode
- `validateUserOwnership`: Ensures user can only access own data (or admin)
- `validateUserExists`: Validates user exists in database

## Password Security

### Password Requirements
- Minimum 6 characters
- At least one uppercase letter
- At least one lowercase letter
- At least one number

### Password Hashing
- Uses bcrypt with 12 salt rounds
- Secure random salt generation
- Timing-safe comparison

## Rate Limiting

### Login Protection
- Maximum 5 failed attempts per IP
- 15-minute lockout window
- Automatic reset on successful login
- In-memory storage (consider Redis for production)

## Default Admin User

### First-time Setup
1. On first startup, if no users exist, a default admin is created
2. Credentials are logged to console
3. **Important**: Change the default password immediately after first login

### Default Credentials
- Username: `admin` (configurable via `DEFAULT_ADMIN_USERNAME`)
- Email: `admin@localhost` (configurable via `DEFAULT_ADMIN_EMAIL`)
- Password: `admin123` (configurable via `DEFAULT_ADMIN_PASSWORD`)
- Role: `admin`

## Usage Examples

### Login
```bash
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "admin123"}'
```

### Get Current User
```bash
curl -X GET http://localhost:3001/api/auth/me \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

### Create User (Admin Only)
```bash
curl -X POST http://localhost:3001/api/users \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{"username": "newuser", "email": "user@example.com", "password": "password123", "role": "user"}'
```

## Frontend Integration

The frontend has been fully integrated with the authentication system, providing:

### Authentication UI Components

1. **FirstTimeSetup Component** (`/src/components/FirstTimeSetup.tsx`)
   - Beautiful app-style welcome screen for new installations
   - Two-step process: welcome and admin account creation
   - Matches the app's design system with proper theming
   - Integrated into the main app flow
   - Automatic admin role assignment for the first user

2. **LoginForm Component** (`/src/components/LoginForm.tsx`)
   - Handles both login and registration
   - Responsive design with proper validation
   - Switches between login/registration modes
   - Shows system info (single/multi-user mode)
   - Proper light/dark mode support

2. **UserMenu Component** (`/src/components/UserMenu.tsx`)
   - Displays current user info
   - Provides logout functionality
   - Shows user management link for admins
   - Responsive dropdown interface

3. **ProtectedRoute Component** (`/src/components/ProtectedRoute.tsx`)
   - Protects routes based on authentication status
   - Supports admin-only routes
   - Handles loading states
   - Respects single-user mode settings

### Pages

1. **LoginPage** (`/src/pages/LoginPage.tsx`)
   - Full-screen login interface
   - Responsive design with centered form

2. **UserManagementPage** (`/src/pages/UserManagementPage.tsx`)
   - Admin-only user management interface
   - Create, update, and delete users
   - Role management
   - Hidden in single-user mode

### State Management

1. **AuthStore** (`/src/store/authStore.ts`)
   - Manages authentication state
   - Handles user info and tokens
   - Automatic token refresh
   - System info caching

2. **API Integration** (`/src/utils/api.ts`)
   - Authentication endpoints
   - User management endpoints
   - Automatic token injection
   - Error handling and redirects

### UI Components

Added reusable UI components:
- `Label` - Form labels with proper styling
- `Card` family - Card container components
- Updated `Button` and `Input` components for auth forms

### Routes and Navigation

The application now supports:
- `/login` - Login/registration page
- `/users` - User management (admin only)
- Protected routes for main app functionality
- Automatic redirect to login when unauthenticated

### Features

1. **Authentication Flow**
   - First-time setup wizard for new installations
   - Login with username/password
   - Registration (if enabled)
   - JWT token management
   - Automatic logout on token expiry

2. **User Management**
   - View all users
   - Create new users
   - Edit user information
   - Delete users
   - Role assignment

3. **Security**
   - Password validation
   - Role-based access control
   - Automatic token refresh
   - Secure logout

4. **User Experience**
   - Loading states
   - Error messages
   - Success notifications
   - Responsive design
   - Keyboard shortcuts

### Testing

The frontend integration has been tested with:
- System info retrieval
- Login/logout flow
- User management operations
- Registration process
- Error handling
- Token management

All components are fully functional and ready for production use.

## Security Considerations

### Production Deployment
1. **Change JWT Secret**: Use a strong, random JWT secret
2. **Change Default Credentials**: Immediately change default admin password
3. **Use HTTPS**: Always use HTTPS in production
4. **Environment Variables**: Keep sensitive data in environment variables
5. **Rate Limiting**: Consider Redis for distributed rate limiting
6. **Token Blacklisting**: Implement token blacklisting for logout
7. **Session Management**: Consider implementing refresh tokens

### Development vs Production
- Development: Relaxed CORS, detailed error messages
- Production: Strict CORS, minimal error disclosure, secure headers

## Single Sign-On (SSO)

Libre WebUI supports OAuth2 authentication with GitHub and Hugging Face.

### GitHub OAuth

1. **Create a GitHub OAuth App:**
   - Go to GitHub Settings → Developer Settings → OAuth Apps → New OAuth App
   - Set Homepage URL: `http://localhost:8080` (or your domain)
   - Set Callback URL: `http://localhost:3001/api/auth/oauth/github/callback`

2. **Configure environment variables:**
   ```env
   GITHUB_CLIENT_ID=your_client_id
   GITHUB_CLIENT_SECRET=your_client_secret
   ```

3. **Enable in the UI:** The GitHub login button appears automatically when configured.

### Hugging Face OAuth

1. **Create a Hugging Face OAuth App:**
   - Go to Hugging Face Settings → Access Tokens → Create new OAuth app
   - Set Callback URL: `http://localhost:3001/api/auth/oauth/huggingface/callback`

2. **Configure environment variables:**
   ```env
   HUGGINGFACE_CLIENT_ID=your_client_id
   HUGGINGFACE_CLIENT_SECRET=your_client_secret
   ```

3. **Enable in the UI:** The Hugging Face login button appears automatically when configured.

### SSO Behavior

- **New users**: Automatically created with `user` role on first SSO login
- **Existing users**: Matched by email address if already registered
- **Admin promotion**: First SSO user is NOT automatically admin (use local account for first admin)

For detailed SSO setup, see the [Single Sign-On Guide](./SSO).

## Extensibility

### Available Features
- GitHub OAuth2 integration
- Hugging Face OAuth2 integration
- JWT-based session management
- Role-based access control (admin/user)
- Per-user data isolation

### Future Enhancements
- Two-factor authentication support
- Additional OAuth providers (Google, Microsoft)
- SAML/LDAP integration
- Advanced role permissions
- User groups and organizations
- Audit logging
- Password recovery via email

### Integration Points
The system is designed to be extensible with:
- Custom authentication providers
- Additional user fields
- Extended role systems
- External user directories
- Compliance features (GDPR, etc.)

## Error Handling

### Common Error Codes
- `400`: Bad Request (validation failed)
- `401`: Unauthorized (invalid/missing token)
- `403`: Forbidden (insufficient permissions)
- `404`: Not Found (user/resource not found)
- `429`: Too Many Requests (rate limited)
- `500`: Internal Server Error

### Error Response Format
```json
{
  "error": "Error message",
  "details": ["Validation error 1", "Validation error 2"]
}
```

## Testing

### Manual Testing
Use the provided curl examples or tools like Postman to test endpoints.

### Automated Testing
The system includes comprehensive validation and error handling suitable for automated testing.

## Troubleshooting

### Common Issues
1. **JWT Secret Not Set**: Ensure `JWT_SECRET` is configured
2. **Default User Not Created**: Check database permissions and logs
3. **Single User Mode**: Verify `SINGLE_USER_MODE` setting
4. **CORS Issues**: Check `CORS_ORIGIN` configuration
5. **Database Errors**: Ensure SQLite file permissions are correct

### Logging
The system provides comprehensive logging for authentication events, errors, and user actions.
