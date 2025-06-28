# Plugin Architecture

Libre WebUI features a comprehensive plugin system that allows routing chat requests through external AI service providers like OpenAI, Anthropic, and custom endpoints that follow the OpenAI-compatible API format.

## Overview

The plugin system acts as a **universal router** for OpenAI-compatible APIs, enabling you to:

- Connect to external AI services (OpenAI, Anthropic, etc.)
- Route chat requests through different providers
- Manage multiple API integrations
- Fallback to local Ollama models when plugins fail
- Export and share plugin configurations

## Plugin Structure

Plugins are defined using JSON configuration files with the following structure:

```json
{
  "id": "openai",
  "name": "OpenAI GPT",
  "type": "completion",
  "endpoint": "https://api.openai.com/v1/chat/completions",
  "auth": {
    "header": "Authorization",
    "prefix": "Bearer ",
    "key_env": "OPENAI_API_KEY"
  },
  "model_map": [
    "gpt-4",
    "gpt-4-turbo", 
    "gpt-4o",
    "gpt-3.5-turbo"
  ]
}
```

### Field Descriptions

- **`id`**: Unique identifier for the plugin
- **`name`**: Human-readable name displayed in the UI
- **`type`**: Plugin type (`completion`, `embedding`, `chat`)
- **`endpoint`**: API endpoint URL
- **`auth`**: Authentication configuration
  - **`header`**: HTTP header name for the API key
  - **`prefix`**: Optional prefix for the API key (e.g., "Bearer ")
  - **`key_env`**: Environment variable name containing the API key
- **`model_map`**: Array of supported model names

## Included Plugins

The system comes with pre-configured plugins for popular services:

### OpenAI Plugin (`plugins/openai.json`)
```json
{
  "id": "openai",
  "name": "OpenAI GPT",
  "type": "completion",
  "endpoint": "https://api.openai.com/v1/chat/completions",
  "auth": {
    "header": "Authorization",
    "prefix": "Bearer ",
    "key_env": "OPENAI_API_KEY"
  },
  "model_map": [
    "gpt-4",
    "gpt-4-turbo",
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-3.5-turbo"
  ]
}
```

### Anthropic Plugin (`plugins/anthropic.json`)
```json
{
  "id": "anthropic",
  "name": "Anthropic Claude",
  "type": "completion",
  "endpoint": "https://api.anthropic.com/v1/messages",
  "auth": {
    "header": "x-api-key",
    "prefix": "",
    "key_env": "ANTHROPIC_API_KEY"
  },
  "model_map": [
    "claude-3-opus-20240229",
    "claude-3-sonnet-20240229",
    "claude-3-haiku-20240307",
    "claude-3-5-sonnet-20241022",
    "claude-3-5-haiku-20241022"
  ]
}
```

## Environment Setup

For plugins to work, you need to set the appropriate environment variables:

```bash
# For OpenAI
export OPENAI_API_KEY="your_openai_api_key_here"

# For Anthropic
export ANTHROPIC_API_KEY="your_anthropic_api_key_here"

# For custom services
export CUSTOM_API_KEY="your_custom_api_key_here"
```

## Using the Plugin System

### 1. Managing Plugins via UI

Access the Plugin Manager through:
- **Settings → Plugins Tab → Open Plugin Manager**

From the Plugin Manager you can:
- Upload plugin `.json` files
- Add plugins via JSON input
- Activate/deactivate plugins
- Export plugin configurations
- Delete plugins

### 2. Plugin API Endpoints

The backend provides comprehensive REST APIs for plugin management:

```bash
# List all plugins
GET /api/plugins

# Get specific plugin
GET /api/plugins/:id

# Install plugin from JSON
POST /api/plugins/install
Content-Type: application/json
{plugin JSON data}

# Upload plugin file
POST /api/plugins/upload
Content-Type: multipart/form-data
{file: plugin.json}

# Update plugin
PUT /api/plugins/:id
{updated plugin data}

# Delete plugin
DELETE /api/plugins/:id

# Activate plugin
POST /api/plugins/activate/:id

# Deactivate current plugin  
POST /api/plugins/deactivate

# Get active plugin
GET /api/plugins/active/current

# Get plugin status
GET /api/plugins/status/all

# Export plugin
GET /api/plugins/:id/export
```

### 3. Chat Request Routing

When a plugin is active, all chat requests are automatically routed through the plugin's endpoint:

1. **Plugin Active**: Chat requests go to the external API
2. **Plugin Fails**: Automatic fallback to local Ollama models
3. **No Plugin**: Direct routing to Ollama models

The system handles:
- Request format conversion (internal → OpenAI compatible)
- Response format conversion (plugin response → internal format)
- Authentication header injection
- Error handling and fallback

## Creating Custom Plugins

### Step 1: Create Plugin Configuration

Create a JSON file following the plugin structure:

```json
{
  "id": "custom-provider",
  "name": "Custom AI Provider",
  "type": "completion",
  "endpoint": "https://your-api.example.com/v1/chat/completions",
  "auth": {
    "header": "Authorization",
    "prefix": "Bearer ",
    "key_env": "CUSTOM_API_KEY"
  },
  "model_map": [
    "custom-model-1",
    "custom-model-2"
  ]
}
```

### Step 2: Set Environment Variable

```bash
export CUSTOM_API_KEY="your_api_key"
```

### Step 3: Install Plugin

Upload via UI or use the API:

```bash
curl -X POST http://localhost:3001/api/plugins/install \
  -H "Content-Type: application/json" \
  -d @custom-plugin.json
```

### Step 4: Activate Plugin

```bash
curl -X POST http://localhost:3001/api/plugins/activate/custom-provider
```

## Plugin Development Guidelines

### OpenAI Compatibility

Ensure your custom API follows the OpenAI chat completions format:

**Request:**
```json
{
  "model": "your-model",
  "messages": [
    {"role": "user", "content": "Hello"}
  ],
  "temperature": 0.7,
  "max_tokens": 1000
}
```

**Response:**
```json
{
  "id": "chatcmpl-123",
  "object": "chat.completion", 
  "created": 1677652288,
  "model": "your-model",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Hello! How can I help you?"
    },
    "finish_reason": "stop"
  }]
}
```

### Authentication Patterns

Common authentication patterns supported:

```json
// Bearer token
"auth": {
  "header": "Authorization",
  "prefix": "Bearer ",
  "key_env": "API_KEY"
}

// API key header
"auth": {
  "header": "x-api-key", 
  "prefix": "",
  "key_env": "API_KEY"
}

// Custom header
"auth": {
  "header": "X-Custom-Auth",
  "prefix": "Token ",
  "key_env": "CUSTOM_TOKEN"
}
```

## Troubleshooting

### Common Issues

1. **Plugin Not Working**
   - Check environment variable is set
   - Verify API endpoint is accessible
   - Check API key permissions

2. **Authentication Errors**
   - Verify `auth.header` matches API requirements
   - Check `auth.prefix` is correct
   - Ensure environment variable name matches `auth.key_env`

3. **Model Not Found**
   - Verify model name is in `model_map`
   - Check if model is available in external service

### Debug Mode

Enable debug logging to troubleshoot issues:

```bash
# Backend logs
NODE_ENV=development npm run dev

# Check plugin status
curl http://localhost:3001/api/plugins/status/all
```

## Security Considerations

- **API Keys**: Store in environment variables, never in plugin files
- **HTTPS**: Always use HTTPS endpoints for external APIs
- **Validation**: Plugin configurations are validated before installation
- **Isolation**: Plugin failures don't crash the main application

## Contributing

To contribute new plugins:

1. Create plugin configuration following the structure
2. Test with your API service
3. Submit pull request with plugin in `plugins/` directory
4. Include documentation and environment setup instructions

## Future Enhancements

- **Streaming Support**: Real-time response streaming through plugins
- **Plugin Marketplace**: Community plugin repository
- **Advanced Routing**: Load balancing and failover between multiple plugins
- **Custom Response Processing**: Plugin-specific response transformations
