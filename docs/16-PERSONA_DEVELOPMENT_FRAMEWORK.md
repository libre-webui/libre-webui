# Persona Development Framework

Libre WebUI's Persona Development Framework lets you create custom AI personalities with unique behaviors, backgrounds, and conversation styles. Build everything from professional assistants to creative companions that match your specific needs.

## What This Gives You

The Persona Framework transforms how you interact with AI by creating **consistent, customized personalities**:

### **Custom AI Personalities**
- Design assistants with specific expertise and communication styles
- Create role-playing characters for creative writing
- Build professional consultants for different domains
- Develop educational tutors with pedagogical approaches

### **Complete Personality Control**
- Set unique conversation tones and mannerisms
- Define specific knowledge domains and expertise
- Configure response styles (formal, casual, technical, creative)
- Establish consistent behavioral patterns

### **Visual Identity**
- Upload custom avatar images for each persona
- Set background themes that match personality
- Create visual distinction between different assistants
- Build immersive conversation experiences

### **Easy Management**
- Import/export personas as JSON files
- Share personalities with teams or community
- Backup and restore custom configurations
- Organize multiple personas efficiently

## Quick Start

### Creating Your First Persona

1. **Navigate to Personas**
   - Click the "Personas" tab in the sidebar
   - Select "Create New Persona"

2. **Basic Information**
   ```
   Name: Research Assistant
   Description: Academic research helper with citation expertise
   Model: Choose your preferred AI model
   ```

3. **Configure Personality**
   - **Temperature**: 0.3 (focused, consistent responses)
   - **System Prompt**: Define the persona's core behavior
   - **Context Window**: Set memory capacity

4. **Add Visual Elements** (Optional)
   - Upload avatar image
   - Set background theme
   - Customize visual appearance

5. **Test and Refine**
   - Start a chat with your new persona
   - Adjust parameters based on responses
   - Fine-tune the system prompt

### System Prompt Examples

**Professional Assistant:**
```
You are a professional business consultant with expertise in strategy and operations. 
Provide clear, actionable advice with supporting rationale. Maintain a confident 
yet approachable tone. Always ask clarifying questions when context is needed.
```

**Creative Writing Companion:**
```
You are an imaginative writing partner who helps develop stories, characters, and 
worlds. Be encouraging and enthusiastic while offering constructive feedback. 
Ask probing questions to help explore creative possibilities.
```

**Technical Expert:**
```
You are a senior software engineer with deep knowledge of web technologies. 
Provide precise, well-structured technical solutions with code examples when 
appropriate. Explain complex concepts clearly and suggest best practices.
```

## Advanced Configuration

### Parameter Tuning

| Parameter | Purpose | Recommended Range |
|-----------|---------|-------------------|
| **Temperature** | Creativity vs Consistency | 0.1-0.3 (focused) to 0.7-0.9 (creative) |
| **Top-P** | Response diversity | 0.8-0.95 for most personas |
| **Context Window** | Memory capacity | 4096+ for complex conversations |
| **Max Tokens** | Response length | 512-2048 depending on use case |

### Specialized Personas

**Customer Support Agent:**
- Temperature: 0.2 (consistent, reliable)
- Focus on problem-solving and empathy
- Include company-specific knowledge in system prompt

**Creative Brainstorm Partner:**
- Temperature: 0.8 (highly creative)
- Encourage wild ideas and unconventional thinking
- Ask "what if" questions to explore possibilities

**Code Review Assistant:**
- Temperature: 0.3 (analytical, precise)
- Focus on best practices and security
- Provide specific improvement suggestions

## Persona Management

### Organizing Your Collection

**Categories to Consider:**
- **Work**: Professional assistants for different domains
- **Learning**: Educational tutors and study partners
- **Creative**: Writing, art, and brainstorming companions
- **Personal**: Lifestyle coaches, hobby experts, entertainment

### Import/Export Features

**Sharing Personas:**
1. Click "Download" on any persona card
2. Share the JSON file with others
3. Recipients can import via "Import Persona"

**Backup Strategy:**
- Regularly export important personas
- Store JSON files in version control
- Document persona evolution and improvements

**JSON Format:**
```json
{
  "name": "Assistant Name",
  "description": "Brief description of personality",
  "model": "model-name:version",
  "params": {
    "temperature": 0.8,
    "top_p": 0.9,
    "context_window": 4096,
    "system_prompt": "You are a helpful assistant with specific traits..."
  },
  "avatar": "/path/to/avatar.png",
  "background": "/path/to/background.png"
}
```

## Best Practices

### Writing Effective System Prompts

**Be Specific:**
- Define exact role and expertise
- Set clear behavioral expectations
- Include relevant background knowledge

**Provide Context:**
- Explain the persona's purpose
- Define the relationship with the user
- Set appropriate boundaries

**Use Examples:**
- Show desired response styles
- Demonstrate problem-solving approaches
- Illustrate personality traits

### Testing and Iteration

**Systematic Testing:**
1. Start with diverse conversation types
2. Test edge cases and difficult questions
3. Evaluate consistency across sessions
4. Gather feedback from intended users

**Refinement Process:**
- Adjust parameters based on response quality
- Refine system prompts for better alignment
- Update descriptions for clarity
- Iterate based on real-world usage

### Performance Optimization

**Resource Management:**
- Use appropriate context windows for task complexity
- Balance creativity with computational efficiency
- Consider token limits for response length

**Model Selection:**
- Match model capabilities to persona requirements
- Use specialized models for domain expertise
- Consider response speed vs quality trade-offs

## Troubleshooting

### Common Issues

**Inconsistent Personality:**
- Increase specificity in system prompt
- Lower temperature for more consistent responses
- Add examples of desired behavior

**Generic Responses:**
- Enhance system prompt with unique characteristics
- Increase temperature slightly for more personality
- Add specific domain knowledge

**Poor Context Retention:**
- Increase context window size
- Summarize important conversation points
- Use structured conversation templates

### Model Compatibility

**Different AI Models:**
- Some models respond better to different prompt styles
- Test personas across available models
- Adjust prompts for optimal model performance

## Security and Privacy

### Data Handling

**Local Processing:**
- Personas run entirely on your local Ollama instance
- No data sent to external services unless using plugin models
- Complete control over conversation privacy

**Sharing Considerations:**
- Review persona exports before sharing
- Remove sensitive information from system prompts
- Consider privacy implications of shared personalities

## Community and Collaboration

### Sharing Best Practices

**Documentation:**
- Document successful persona configurations
- Share prompt engineering techniques
- Contribute to community knowledge base

**Collaboration:**
- Build team-specific personas for consistent interactions
- Share domain expertise through specialized personalities
- Create educational personas for training purposes

---

## Next Steps

- **[🤖 Working with Models](./02-WORKING_WITH_MODELS.md)** - Choose the right AI model for your personas
- **[🔌 Plugin Architecture](./08-PLUGIN_ARCHITECTURE.md)** - Connect external AI services for specialized personas
- **[🎯 Pro Tips](./03-PRO_TIPS.md)** - Advanced techniques for power users

---

*The Persona Development Framework is continuously evolving. Check the [Changelog](../CHANGELOG.md) for the latest persona features and improvements.*
