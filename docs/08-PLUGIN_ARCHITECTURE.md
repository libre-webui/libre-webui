# Plugin Architecture

Libre WebUI's plugin system lets you connect multiple AI services through a single interface. Access OpenAI's GPT models, Anthropic's Claude, Groq, Cohere, and custom AI APIs without switching between different platforms.

## What This Gives You

The plugin system acts as a **unified interface** for different AI providers:

### **Multiple AI Services in One Place**
- Use GPT-4 for detailed analysis
- Switch to Claude for different perspectives
- Try Groq for faster responses
- Access Cohere for specialized tasks
- All from the same chat interface

### **Easy Model Switching**
- Compare responses from different models
- Switch providers mid-conversation
- Test which AI works best for your tasks

### **Reliable Fallbacks**
- If one service is unavailable, automatically use another
- Local Ollama models work as backup
- No interruption to your workflow

### **Cost Management**
- Use premium models only when needed
- Route simple tasks to more affordable options
- Track usage across different services

## How It Works

The plugin system connects to different AI services through standardized configurations:

### **Supported Services**
- **Popular Providers**: OpenAI, Anthropic, Cohere, Groq, Mistral
- **Custom APIs**: Your own models or company services
- **Local Models**: Ollama, LM Studio, other OpenAI-compatible endpoints
- **Easy Expansion**: New services can be added with simple JSON configs

### **Management Features**
- Install plugins by uploading JSON files
- Enable/disable services through settings
- Switch between providers during conversations
- Share configurations with team members

### **Reliability Features**
- Automatic failover when services are unavailable
- Load balancing across multiple providers
- Usage tracking and analytics
- Centralized API key management

## Common Use Cases

### **Content Creation**
- Research with Claude for structure and facts
- Write creatively with GPT-4
- Get quick feedback from Groq
- Keep sensitive content on local models

### **Development Work**
- Debug code with GPT-4's detailed analysis
- Generate documentation with Claude
- Get quick syntax help from faster models
- Review code privately with local models

### **Comparing AI Responses**
- Ask the same question to multiple models
- Compare different approaches and styles
- Find which AI works best for specific tasks
- Learn from different perspectives

### **Business Tasks**
- Use Claude for data analysis
- Switch to GPT-4 for presentations
- Route simple tasks to cost-effective models
- Keep confidential data on local systems

## Future Development

### **Planned Features**
- Smart routing based on task type
- Streaming responses from multiple models
- Enhanced cost tracking and analytics
- Team collaboration features
- Model response combining
- Advanced failover options

### **Community Contributions**
- Plugin marketplace for easy sharing
- Custom model integrations
- API gateway features
- Multi-modal support (text, images, audio)

### **Enterprise Additions**
- Usage analytics dashboard
- Role-based access controls
- Audit logging for compliance
- On-premises deployment options

## Benefits

### **Flexibility**
- No vendor lock-in to a single AI service
- Easy to switch between different models
- Test new services without changing workflows

### **Efficiency**
- Single interface for multiple AI services
- Automatic fallbacks prevent downtime
- Cost optimization through smart routing

### **Future-Ready**
- New AI services can be added easily
- Standardized plugin format
- Community-driven ecosystem

---

## Quick Start

### Step 1: Get API Keys
Get free API keys from:
- OpenAI: https://platform.openai.com/api-keys
- Anthropic: https://console.anthropic.com/
- Groq: https://console.groq.com/keys

### Step 2: Configure Environment
Add to your `.env` file:
```bash
OPENAI_API_KEY=your_openai_key_here
ANTHROPIC_API_KEY=your_anthropic_key_here
GROQ_API_KEY=your_groq_key_here
```

### Step 3: Enable Plugins
- Go to Settings → Plugins
- Enable the services you want to use

### Step 4: Start Using
- Select a model from any enabled service
- Chat normally - the system handles routing automatically
- Switch models anytime to compare responses

---

## Technical Implementation

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
## Troubleshooting

### Common Issues

**Plugin not working:**
- Check if API key is set in .env file
- Verify plugin is enabled in settings
- Test internet connection
- Try a different model from the same provider

**Authentication errors:**
- Verify API key is copied correctly (no extra spaces)
- Check if API key has usage credits remaining
- Restart server after adding new keys
- Confirm key has proper permissions

**Model not found:**
- Check if model name exists in plugin configuration
- Verify model is available in your API account
- Try a different model from the same provider
- Some models require special access approval

### Debug Information
```bash
# View detailed logs:
NODE_ENV=development npm run dev

# Check plugin status:
curl http://localhost:3001/api/plugins/status/all
```

## Security & Best Practices

### API Key Security
- Store API keys in environment variables only
- Never include keys in plugin files or code
- Use HTTPS endpoints for all external services
- Don't share API keys in documentation or screenshots

### System Protection
- Plugin failures won't crash the application
- Invalid configurations are rejected automatically
- Each plugin operates independently
- Automatic fallback to local models when needed

## Contributing

### Adding New Plugins
If you have access to an AI service that others might find useful:
1. Create a plugin JSON configuration
2. Test it thoroughly with your API
3. Submit a pull request
4. Include setup documentation

### Improving Documentation
Help make the plugin system easier to understand:
1. Clarify confusing sections
2. Add practical examples
3. Share successful configurations
4. Write tutorials for common use cases

### Reporting Issues
Your feedback helps improve the system:
1. Report bugs with specific details
2. Suggest new features
3. Share your use cases
4. Help prioritize development efforts

## Summary

The plugin system provides a practical way to access multiple AI services through a single interface. Key advantages include:

- **Flexibility**: Easy switching between different AI providers
- **Reliability**: Automatic fallbacks when services are unavailable  
- **Cost Control**: Use appropriate models for each task
- **Future-Ready**: Simple integration of new AI services
- **Privacy Options**: Keep sensitive data on local models

Whether you're comparing AI responses, optimizing costs, or ensuring reliable access to AI services, the plugin system offers a straightforward solution for managing multiple AI providers.
