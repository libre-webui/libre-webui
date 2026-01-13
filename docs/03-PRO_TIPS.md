---
sidebar_position: 1
title: "Pro Tips & Advanced Features"
description: "Advanced workflows and power user techniques for Libre WebUI. Exclusive productivity features including system prompts, model optimization, and expert workflows."
slug: /PRO_TIPS
keywords: [libre webui pro tips, advanced ai workflows, power user ai, system prompts, ai optimization, productivity ai, advanced ai techniques, expert ai usage, open webui alternative]
image: /img/social/03.png
---

# 🎯 Pro Tips: Advanced Workflows

Ready to become a power user? Here are advanced techniques to get more from Libre WebUI.

:::tip Reading Time
**~10 minutes** to master advanced workflows that will transform how you use AI
:::

## 🚀 Power User Workflows

Master these proven workflows to maximize your productivity:

## ✍️ Writing Assistant Workflow

**Perfect for content creators, authors, and professional writers:**

**1. Set up your creative assistant:**
```
You are a creative writing assistant. Help me brainstorm, outline, and refine stories. 
Focus on character development, plot structure, and engaging dialogue.
```

**2. Use structured outputs:**
- Request outlines in JSON format
- Ask for character profiles in lists
- Get plot summaries in markdown

**3. Model strategy:**
- `llama3.2:3b` for quick brainstorming
- `llama3.3:70b` for complex narrative analysis
- `gemma3:4b` for balanced writing assistance

:::tip Writing Workflow
Start with fast models for ideas, then switch to powerful models for refinement and detailed work.
:::

## 💼 Business Productivity Workflow

**Streamline your professional communication and analysis:**

**1. Professional communication setup:**
```
You are a professional communication assistant. Help me write clear, concise business communications. 
Focus on clarity, professionalism, and actionable outcomes.
```

**2. Document processing workflow:**

- Use `qwen2.5vl:32b` for analyzing uploaded charts/images
- Generate summaries and action items
- Create meeting notes and follow-ups

**3. Email assistance patterns:**

- "Draft a follow-up email for..."
- "Summarize this document and highlight key points"
- "Create a professional response to..."

## 💻 Programming Helper Workflow

**For developers and technical professionals:**

**1. Use `devstral:24b` for advanced coding:**

- Complex architecture design
- Code reviews and optimization
- Debugging assistance

**2. Code analysis workflow:**

- Upload code screenshots for analysis
- Get debugging help with context
- Request architectural improvements

**3. Development patterns:**

- "Review this code for security issues"
- "Optimize this algorithm for performance"
- "Explain this complex codebase"

## 🔬 Research & Analysis Workflow

**For academics, analysts, and researchers:**

**1. Multi-model research strategy:**

- Fast models for initial exploration
- Larger models for deep analysis
- Vision models for chart/graph analysis

**2. Research workflow:**

- Upload visual data for analysis
- Generate structured research summaries
- Create comparative analyses

**3. Analysis patterns:**

- "What are the implications of..."
- "Compare and contrast these approaches"
- "Synthesize findings from these sources"

---
2. Upload code screenshots for analysis
3. Get debugging help and code reviews

### **Research & Analysis**
1. Use fast models for exploration
2. Switch to larger models for deep analysis
3. Upload charts/graphs for visual analysis

## 🛠️ Advanced Features Mastery

### 🔀 **Message Branching**

Explore alternative AI responses without losing your conversation history:

**What is Message Branching?**
- **Regenerate responses** to create alternative versions
- **Compare variants** side-by-side in a grid layout
- **Switch between branches** with a single click
- **Preserve all versions** for reference

**How to Use:**
1. Hover over any assistant message
2. Click the **regenerate** button (↻)
3. A new variant appears alongside the original
4. Click any variant to make it the active response
5. Continue the conversation from your chosen branch

**Pro Tips:**
- Use branching to explore different approaches to the same question
- Compare coding solutions or writing styles
- Keep multiple draft options before committing
- Each branch maintains full conversation context

**Visual Indicators:**
- Active branch shows a checkmark (✓)
- Branch count displays with git icon (e.g., "3 variants")
- Streaming variants show "generating..." with pulse animation

---

### 🖼️ **Image Generation Gallery**

Generate and manage AI-created images in a dedicated gallery:

**Accessing the Gallery:**
- Click **Imagine** in the sidebar
- View all generated images in a masonry grid layout
- Images load progressively with infinite scroll

**Generating Images:**
1. Click **Generate Image** button
2. Enter your prompt describing the image
3. Select model and size options
4. Click generate and watch it appear in the gallery

**Gallery Features:**
- **Masonry layout**: 1-4 columns adapts to screen size
- **Lightbox view**: Click any image for full-screen preview
- **Image details**: View prompt, model, size, quality, and creation date
- **Download**: Save images locally with proper filenames
- **Delete**: Remove images with confirmation

**Lightbox Information Panel:**
- Full prompt text
- Model used for generation
- Image dimensions
- Quality setting
- Creation timestamp

**Storage:**
- Images encrypted at rest
- Stored per-user for privacy
- Accessible only to the creating user

---

### 🖼️ **Multimodal Excellence**
**Best Practices for Image Analysis:**

- **Upload Quality:** Use clear, high-resolution images
- **Context Matters:** Provide background information
- **Specific Questions:** Ask focused questions about image content
- **Multiple Angles:** Upload several images of the same subject

**Pro Image Workflow:**
1. Upload image(s) - up to 5 per message
2. Start with broad questions: "What do you see in this image?"
3. Follow up with specific questions: "What's the text in the top-right corner?"
4. Use for document OCR, chart analysis, and visual problem-solving

### 📊 **Structured Output Mastery**
**Advanced JSON Schema Techniques:**

**Custom Analysis Template:**
```json
{
  "summary": "Brief overview",
  "key_points": ["Point 1", "Point 2", "Point 3"],
  "recommendations": ["Action 1", "Action 2"],
  "confidence_level": "High/Medium/Low",
  "next_steps": ["Step 1", "Step 2"]
}
```

**Data Extraction Template:**
```json
{
  "entities": {
    "people": ["Name 1", "Name 2"],
    "organizations": ["Org 1", "Org 2"],
    "dates": ["2024-01-01"],
    "locations": ["City, Country"]
  },
  "sentiment": "positive/negative/neutral",
  "topics": ["Topic 1", "Topic 2"]
}
```

### ⚡ **Performance Optimization**
**Memory Management:**
- Monitor running models in the Models section
- Use smaller models for simple tasks
- Load larger models only when needed
- Close unused models to free memory

**Speed Optimization:**
- Keep frequently used models loaded
- Use appropriate model sizes for tasks
- Batch similar questions together
- Utilize streaming for long responses

**Quality Optimization:**
- Adjust temperature based on task type
- Use system prompts for consistency
- Provide examples in your prompts
- Iterate and refine prompts based on results

## 🎭 **Model Selection Strategy**

### **Task-Based Model Selection**

| Task Type | Recommended Model | Why |
|-----------|------------------|-----|
| **Quick Q&A** | `llama3.2:1b` | Ultra-fast, efficient for simple questions |
| **General Chat** | `gemma3:4b` | Current most capable single-GPU model |
| **Complex Reasoning** | `deepseek-r1:32b` | Advanced reasoning approaching O3 performance |
| **State-of-the-art Analysis** | `llama3.3:70b` | Performance similar to llama3.1:405b but more efficient |
| **Advanced Programming** | `devstral:24b` | Best open source model for coding agents |
| **Vision & Image Analysis** | `qwen2.5vl:32b` | Flagship vision-language model with significant leap in capability |
| **Multimodal Tasks** | `llama4:16x17b` | Meta's latest multimodal collection |
| **Thinking & Reasoning** | `qwen3:32b` | Latest generation with mixture-of-experts and thinking capabilities |
| **Efficient Performance** | `phi4:14b` | Microsoft's state-of-the-art compact model |

### **Multi-Model Workflows**
**Advanced Reasoning Pipeline:**
1. **Initial Analysis** (`gemma3:4b`): Quick overview and key insights
2. **Deep Reasoning** (`deepseek-r1:32b`): Complex thinking and problem-solving
3. **Visual Analysis** (`qwen2.5vl:32b`): Charts, documents, and visual data
4. **Final Synthesis** (`llama3.3:70b`): Comprehensive conclusions

**Development Pipeline:**
1. **Planning** (`qwen3:32b`): Architecture and design thinking
2. **Coding** (`devstral:24b`): Advanced code generation and debugging
3. **UI/UX Review** (`llama4:16x17b`): Multimodal interface feedback
4. **Documentation** (`phi4:14b`): Efficient technical writing

**Research Pipeline:**
1. **Exploration** (`gemma3:4b`): Fast initial research
2. **Deep Analysis** (`deepseek-r1:32b`): Complex reasoning and connections
3. **Visual Data** (`qwen2.5vl:32b`): Chart and document analysis
4. **Summary** (`llama3.3:70b`): Comprehensive research synthesis

## 🚀 **2025 Model Capabilities & Features**

### **🧠 Reasoning Models**
**DeepSeek-R1** series brings advanced reasoning capabilities:
- **Thinking Process**: Models show their reasoning steps
- **Problem Solving**: Approaching O3-level performance
- **Available Sizes**: 1.5B to 671B parameters
- **Best For**: Complex analysis, mathematical problems, logical reasoning

### **🎯 Specialized Models**
**Devstral**: The premier coding assistant
- **Coding Agents**: Advanced autonomous programming
- **24B Parameters**: Optimal balance of capability and efficiency
- **Best For**: Complex software development, debugging, code review

### **👁️ Vision-Language Excellence**
**Qwen2.5VL**: Flagship multimodal model
- **Significant Leap**: Major improvement over previous versions
- **Document OCR**: Superior text extraction from images
- **Chart Analysis**: Advanced data visualization understanding
- **Available Sizes**: 3B to 72B parameters

### **⚡ Efficiency Champions**
**Gemma3**: Current single-GPU champion
- **GPU Optimized**: Runs efficiently on single graphics cards
- **Vision Capable**: Includes multimodal versions
- **Sizes**: 1B to 27B parameters
- **Best For**: Resource-constrained environments with high performance needs

**Phi4**: Microsoft's compact powerhouse
- **14B Parameters**: State-of-the-art performance in compact size
- **Efficiency**: Optimized for speed and memory usage
- **Best For**: Edge deployment, fast inference, mobile devices

## 🔧 **Custom System Prompts Library**

### **Professional Templates**

**Executive Assistant:**
```
You are an executive assistant AI. Help with scheduling, email drafting, meeting preparation, and professional communications. Be concise, professional, and action-oriented.
```

**Technical Writer:**
```
You are a technical documentation specialist. Create clear, accurate, and user-friendly documentation. Use proper formatting, include examples, and anticipate user questions.
```

**Data Analyst:**
```
You are a data analysis expert. Interpret data, identify trends, explain statistical concepts in simple terms, and provide actionable insights based on evidence.
```

### **Creative Templates**

**Story Consultant:**
```
You are a story development consultant. Help with plot structure, character development, dialogue, pacing, and narrative techniques. Ask probing questions to develop ideas.
```

**Brand Strategist:**
```
You are a brand strategy expert. Help develop brand voice, messaging, positioning, and creative concepts. Focus on audience connection and differentiation.
```

## 📈 **Measuring Success**

### **Quality Indicators**
- **Relevance:** Responses directly address your questions
- **Accuracy:** Information is factually correct
- **Usefulness:** Output helps accomplish your goals
- **Efficiency:** Time saved vs. manual work

### **Optimization Metrics**
- **Response Time:** How quickly you get useful output
- **Iteration Count:** How many refinements needed
- **Model Switching:** Frequency of changing models
- **Prompt Reuse:** How often you reuse successful prompts

## 🌟 **Next-Level Techniques**

### **Prompt Chaining**
Break complex tasks into sequential prompts:

1. **Analysis Prompt:** "Analyze this document for key themes"
2. **Synthesis Prompt:** "Based on the themes, what are the implications?"
3. **Action Prompt:** "What specific actions should we take?"

### **Context Building**
Gradually build context across messages:
- Start with broad overview
- Add specific details
- Reference previous responses
- Build on established understanding

### **Multi-Modal Integration**
Combine text and images effectively:
- Upload supporting visuals
- Reference image elements in text
- Use images to clarify text descriptions
- Create comprehensive multimedia responses

---

**🏆 You're now ready to unlock the full potential of Libre WebUI!**

*Remember: The best workflows are the ones you customize for your specific needs. Experiment, iterate, and find what works best for you.*
