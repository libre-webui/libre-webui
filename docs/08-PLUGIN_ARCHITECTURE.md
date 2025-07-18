---
sidebar_position: 3
title: "Plugin Architecture"
description: "Advanced plugin architecture in Libre WebUI supporting 207+ AI models. Comprehensive external AI integration with OpenAI, Anthropic, Claude, Groq, Gemini, Mistral, and GitHub Models."
slug: /PLUGIN_ARCHITECTURE
keywords: [libre webui plugins, 207+ ai models, ai plugin architecture, openai integration, anthropic claude, groq ai, gemini ai, mistral ai, github models, external ai services, open webui alternative]
image: /img/docusaurus-social-card.jpg
---

# Plugin Architecture

Libre WebUI's plugin system lets you connect multiple AI services through a single interface. Access OpenAI's GPT models, Anthropic's Claude, Groq, Mistral, GitHub Models, Google Gemini, and custom AI APIs without switching between different platforms.

## What This Gives You

The plugin system acts as a **unified interface** for different AI providers:

### **Multiple AI Services in One Place**
- Use GPT-4 for detailed analysis
- Switch to Claude for different perspectives
- Try Groq for faster responses
- Access Mistral for efficient processing
- Use GitHub Models for free premium access
- Leverage Google Gemini for advanced capabilities
- All from the same chat interface

### **Easy Model Switching**
- Compare responses from different models
- Switch providers mid-conversation
- Test which AI works best for your tasks
- Access 207+ models across 6 major providers

### **Reliable Fallbacks**
- If one service is unavailable, automatically use another
- Local Ollama models work as backup
- No interruption to your workflow

### **Cost Management**
- Use premium models only when needed
- Route simple tasks to more affordable options
- Take advantage of free GitHub Models
- Track usage across different services

## How It Works

The plugin system connects to different AI services through standardized configurations:

### **Supported Services**
- **OpenAI**: GPT-4, GPT-4o, ChatGPT, o3, o4, and all variants (67 models)
- **Anthropic**: Claude 4 Sonnet, Claude 4 Opus, Claude 3.7 Sonnet, Claude 3.5 Sonnet, Opus, Haiku (13 models)
- **Groq**: Ultra-fast inference with Llama, Gemma, Mistral (14 models)
- **Google Gemini**: Gemini 1.5/2.0/2.5 models and experimental variants (45 models)
- **Mistral**: Mistral Large, Small, Nemo, Codestral (48 models)
- **GitHub Models**: Free access to premium models from multiple providers (20 models)
- **Custom APIs**: Your own models or company services
- **Local Models**: Ollama, LM Studio, other OpenAI-compatible endpoints

### **Automated Model Management**
- **Dynamic Updates**: Automatically fetch latest models from APIs
- **Smart Filtering**: Remove non-chat models (embeddings, TTS, etc.)
- **Backup System**: Automatic backup before updates
- **Error Handling**: Robust error checking and recovery
- **Update Scripts**: Individual and bulk update capabilities

### **Management Features**
- Install plugins by uploading JSON files
- Enable/disable services through settings
- Switch between providers during conversations
- Share configurations with team members
- Automated model list updates

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
- Google AI: https://ai.google.dev/
- Mistral: https://console.mistral.ai/
- GitHub: https://github.com/settings/personal-access-tokens

### Step 2: Configure Environment
Add to your `.env` file:
```bash
OPENAI_API_KEY=your_openai_key_here
ANTHROPIC_API_KEY=your_anthropic_key_here
GROQ_API_KEY=your_groq_key_here
GEMINI_API_KEY=your_gemini_key_here
MISTRAL_API_KEY=your_mistral_key_here
GITHUB_API_KEY=your_github_token_here
```

### Step 3: Update Plugin Models
Run the automated update system:
```bash
# Update all providers at once
./scripts/update-all-models.sh

# Or update individual providers
./scripts/update-openai-models.sh
./scripts/update-anthropic-models.sh
./scripts/update-groq-models.sh
./scripts/update-gemini-models.sh
./scripts/update-mistral-models.sh
./scripts/update-github-models.sh
```

### Step 4: Enable Plugins
- Go to Settings → Plugins
- Enable the services you want to use

### Step 5: Start Using
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

The system comes with pre-configured plugins for popular services and automated update scripts:

### OpenAI Plugin (`plugins/openai.json`)
- **Models**: 67 current models including o3, o4, GPT-4, GPT-4o, ChatGPT variants
- **Update Method**: Dynamic API fetching
- **Endpoint**: `https://api.openai.com/v1/chat/completions`

### Anthropic Plugin (`plugins/anthropic.json`)
- **Models**: 13 current models including Claude 4 Sonnet, Claude 4 Opus, Claude 3.7 Sonnet, Claude 3.5 Sonnet
- **Update Method**: Dynamic API fetching with manual curation
- **Endpoint**: `https://api.anthropic.com/v1/messages`

### Groq Plugin (`plugins/groq.json`)
- **Models**: 14 current models with ultra-fast inference
- **Update Method**: Dynamic API fetching
- **Endpoint**: `https://api.groq.com/openai/v1/chat/completions`

### Google Gemini Plugin (`plugins/gemini.json`)
- **Models**: 45 current models including Gemini 1.5/2.0/2.5 variants
- **Update Method**: Dynamic API fetching
- **Endpoint**: `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`

### Mistral Plugin (`plugins/mistral.json`)
- **Models**: 48 current models including Mistral Large, Small, Nemo, Codestral
- **Update Method**: Dynamic API fetching
- **Endpoint**: `https://api.mistral.ai/v1/chat/completions`

### GitHub Models Plugin (`plugins/github.json`)
- **Models**: 20 premium models from OpenAI, Meta, Microsoft, Mistral
- **Update Method**: Dynamic API fetching
- **Endpoint**: `https://models.inference.ai.azure.com/chat/completions`
- **Special**: Free access to premium models

## Automated Update System

The plugin system includes automated scripts to keep model lists current:

### Update Scripts
- `update-openai-models.sh` - Fetches OpenAI models via API
- `update-anthropic-models.sh` - Updates manually curated Claude models
- `update-groq-models.sh` - Fetches Groq models via API
- `update-gemini-models.sh` - Fetches Google Gemini models via API
- `update-mistral-models.sh` - Fetches Mistral models via API
- `update-github-models.sh` - Fetches GitHub Models via API
- `update-all-models.sh` - Updates all providers at once

### Features
- **Automatic Backup**: Creates `.backup` files before updating
- **Error Handling**: Robust error checking and recovery
- **Smart Filtering**: Removes non-chat models (embeddings, TTS, etc.)
- **Status Reporting**: Detailed progress and statistics
- **API Key Validation**: Checks for required environment variables

## Environment Setup

For plugins to work, you need to set the appropriate environment variables:

```bash
# For OpenAI
export OPENAI_API_KEY="your_openai_api_key_here"

# For Anthropic
export ANTHROPIC_API_KEY="your_anthropic_api_key_here"

# For Groq
export GROQ_API_KEY="your_groq_api_key_here"

# For Google Gemini
export GEMINI_API_KEY="your_gemini_api_key_here"

# For Mistral
export MISTRAL_API_KEY="your_mistral_api_key_here"

# For GitHub Models
export GITHUB_API_KEY="your_github_token_here"

# For custom services
export CUSTOM_API_KEY="your_custom_api_key_here"
```

## Model Statistics

Current model counts across all providers:

| Provider | Models | Update Method | Free Tier |
|----------|---------|---------------|-----------|
| OpenAI | 67 | Dynamic API | Limited |
| Anthropic | 13 | Dynamic API | Limited |
| Groq | 14 | Dynamic API | Generous |
| Google Gemini | 45 | Dynamic API | Generous |
| Mistral | 48 | Dynamic API | Limited |
| GitHub Models | 20 | Dynamic API | **Free** |
| **Total** | **207** | 6 APIs | Mixed |

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
- Run the update script for that provider

**Authentication errors:**
- Verify API key is copied correctly (no extra spaces)
- Check if API key has usage credits remaining
- Restart server after adding new keys
- Confirm key has proper permissions

**Model not found:**
- Check if model name exists in plugin configuration
- Verify model is available in your API account
- Run the update script to refresh model list
- Try a different model from the same provider
- Some models require special access approval

**Update script issues:**
- Ensure API key environment variable is set
- Check internet connectivity
- Verify API endpoint is accessible
- Run individual update scripts to isolate issues

### Debug Information
```bash
# View detailed logs:
NODE_ENV=development npm run dev

# Check plugin status:
curl http://localhost:3001/api/plugins/status/all

# Test individual update scripts:
./scripts/update-openai-models.sh
./scripts/update-anthropic-models.sh
./scripts/update-groq-models.sh
./scripts/update-gemini-models.sh
./scripts/update-mistral-models.sh
./scripts/update-github-models.sh

# Update all providers:
./scripts/update-all-models.sh
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
