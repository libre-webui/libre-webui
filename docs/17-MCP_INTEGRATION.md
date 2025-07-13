# 🔌 Model Context Protocol (MCP) Integration

**Connect your AI models to powerful tools and resources through the Model Context Protocol.**

## 📖 What is MCP?

The **Model Context Protocol (MCP)** is an open standard that enables Large Language Models (LLMs) to securely connect with external data sources and tools. Think of it as a universal translator that allows your AI to interact with:

- **File systems** - Read and manipulate files on your computer
- **Databases** - Query SQL databases, NoSQL stores, and more  
- **APIs** - Connect to web services and REST APIs
- **Development tools** - Git repositories, build systems, testing frameworks
- **Custom tools** - Any application that implements MCP

## 🚀 Quick Setup

### 1. **Access MCP Management**
Navigate to **Settings** → **MCP Management** in the sidebar

### 2. **Add Your First MCP Server**
Click **"Add MCP Server"** and configure:

```yaml
Name: Local File System
Description: Access local files and directories  
Type: stdio
Command: npx
Arguments: @modelcontextprotocol/server-filesystem /path/to/directory
Timeout: 30000ms
Max Retries: 3
```

### 3. **Test Connection**
- Click **"Connect"** to establish the connection
- Browse available **Tools** and **Resources**
- Test tool execution with sample inputs

## 🔧 MCP Server Types

### **stdio** (Recommended)
- **Best for:** Local applications and command-line tools
- **Setup:** Specify command and arguments
- **Example:** File system, Git, local databases

### **SSE (Server-Sent Events)**
- **Best for:** Web-based MCP servers
- **Setup:** Provide HTTP URL endpoint
- **Example:** Cloud APIs, web services

### **WebSocket**
- **Best for:** Real-time applications
- **Setup:** Provide WebSocket URL
- **Example:** Live data feeds, chat systems

## 🛠️ Popular MCP Servers

### **File System Access**
```bash
# Install the official filesystem server
npm install -g @modelcontextprotocol/server-filesystem

# Configuration
Command: npx
Arguments: @modelcontextprotocol/server-filesystem /Users/yourname/Documents
```

### **Git Repository Management**
```bash
# Install git server
npm install -g @modelcontextprotocol/server-git

# Configuration  
Command: npx
Arguments: @modelcontextprotocol/server-git --repository /path/to/repo
```

### **SQLite Database**
```bash
# Install SQLite server
npm install -g @modelcontextprotocol/server-sqlite

# Configuration
Command: npx  
Arguments: @modelcontextprotocol/server-sqlite --db-path /path/to/database.db
```

### **Web Search**
```bash
# Install web search server
npm install -g @modelcontextprotocol/server-brave-search

# Configuration (requires API key)
Command: npx
Arguments: @modelcontextprotocol/server-brave-search
Environment: BRAVE_API_KEY=your_api_key_here
```

## 🎯 Using MCP Tools

### **1. Browse Available Tools**
- Go to **MCP Management** → **Tools** tab
- View all available tools from connected servers
- See tool descriptions and required parameters

### **2. Execute Tools**
- Select a tool to view its parameters
- Fill in required arguments in the dynamic form
- Click **"Execute Tool"** to run
- View results in real-time

### **3. Access Resources**
- Switch to **Resources** tab
- Browse files, data, and content from MCP servers
- Read resource content directly in the interface
- Download binary resources when available

## 🔒 Security & Best Practices

### **Principle of Least Privilege**
- Only grant access to directories/resources you need
- Use specific paths instead of root directory access
- Regularly audit connected MCP servers

### **Environment Variables**
- Store API keys and secrets in environment variables
- Never commit credentials to configuration files
- Use `.env` files for local development

### **Network Security**
- Verify MCP server sources before installation
- Use HTTPS/WSS for remote connections
- Monitor network traffic from MCP servers

## 🔧 Advanced Configuration

### **Custom Environment Variables**
```bash
# Set environment variables for MCP servers
OPENAI_API_KEY=sk-...
DATABASE_URL=postgresql://user:pass@localhost/db
API_BASE_URL=https://api.example.com
```

### **Command Arguments**
```bash
# File system with specific permissions
npx @modelcontextprotocol/server-filesystem --readonly /Documents

# Git with specific branch
npx @modelcontextprotocol/server-git --branch main --repository /repo

# Database with connection options  
npx @modelcontextprotocol/server-postgres --host localhost --port 5432
```

### **Timeout & Retry Settings**
- **Timeout:** 30000ms (30 seconds) recommended for most tools
- **Max Retries:** 3 attempts with exponential backoff
- **Adjust based on:** Tool complexity and network conditions

## 🚨 Troubleshooting

### **Connection Issues**
```bash
# Check if MCP server is installed
npm list -g @modelcontextprotocol/server-filesystem

# Test server manually
npx @modelcontextprotocol/server-filesystem /path/to/test
```

### **Permission Errors**
- Verify file/directory permissions
- Check if paths exist and are accessible
- Ensure environment variables are set correctly

### **Tool Execution Failures**
- Validate input parameters match expected format
- Check server logs in the MCP Management interface
- Verify network connectivity for remote servers

### **Common Error Messages**

| Error | Solution |
|-------|----------|
| `Command not found` | Install the MCP server package with npm |
| `Permission denied` | Check file/directory permissions |
| `Connection timeout` | Increase timeout value or check network |
| `Invalid arguments` | Verify tool parameter format and types |

## 🔍 Debugging

### **Enable Debug Logging**
1. Go to **MCP Management** → **Server Details**
2. Enable **"Debug Mode"** for detailed logs
3. Monitor connection status and error messages
4. Check tool execution logs for troubleshooting

### **Test Server Manually**
```bash
# Test MCP server outside of Libre WebUI
npx @modelcontextprotocol/server-filesystem /tmp

# Check if server responds to MCP protocol
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | npx server
```

## 🌟 Real-World Examples

### **Code Development Workflow**
```yaml
# Git Repository Access
Name: Project Repository
Command: npx @modelcontextprotocol/server-git
Arguments: --repository /Users/dev/my-project

# File System Access  
Name: Source Code
Command: npx @modelcontextprotocol/server-filesystem
Arguments: /Users/dev/my-project/src
```

**AI Workflow:**
1. "Show me the latest commits" → Uses Git MCP tool
2. "Read the main.py file" → Uses File System MCP resource
3. "Create a new feature branch" → Uses Git MCP tool

### **Data Analysis Workflow**
```yaml
# Database Access
Name: Analytics DB
Command: npx @modelcontextprotocol/server-sqlite  
Arguments: --db-path /data/analytics.db

# CSV File Access
Name: Data Files
Command: npx @modelcontextprotocol/server-filesystem
Arguments: /data/csv-files
```

**AI Workflow:**
1. "What tables are in the database?" → Uses SQLite MCP tool
2. "Read the sales data CSV" → Uses File System MCP resource  
3. "Query total sales by month" → Uses SQLite MCP tool

## 📚 Further Reading

- **[Official MCP Documentation](https://github.com/modelcontextprotocol/docs)** - Complete protocol specification
- **[MCP Server Registry](https://github.com/modelcontextprotocol/servers)** - Community MCP servers
- **[Building MCP Servers](https://modelcontextprotocol.org/docs/building-servers)** - Create custom servers
- **[MCP SDK Documentation](https://modelcontextprotocol.org/docs/sdk)** - TypeScript/Python SDKs

## 🤝 Community

- **[MCP Community Discord](https://discord.gg/mcp)** - Get help and share experiences
- **[GitHub Discussions](https://github.com/modelcontextprotocol/docs/discussions)** - Technical discussions
- **[Server Examples](https://github.com/modelcontextprotocol/servers)** - Open source MCP implementations

---

**🎉 Ready to supercharge your AI with MCP?**

**[Start with the File System MCP server →](#popular-mcp-servers)**
