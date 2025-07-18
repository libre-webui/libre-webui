---
sidebar_position: 2
title: "Artifacts Feature"
description: "Revolutionary Artifacts feature in Libre WebUI. Create advanced interactive content with HTML, SVG, code execution, and dynamic sandboxed rendering."
slug: /ARTIFACTS_FEATURE
keywords: [libre webui artifacts, interactive ai content, ai code execution, html ai generation, svg ai creation, dynamic ai content, sandboxed ai rendering, advanced ai features, open webui alternative]
image: /img/docusaurus-social-card.jpg
---

# 🎨 Artifacts Feature Guide

The Artifacts feature in Libre WebUI allows you to create and interact with dynamic, executable content directly within chat conversations. This feature automatically detects code blocks and converts them into interactive, rendered artifacts.

## Overview

Artifacts transform static code blocks into interactive, rendered content that you can:
- View in real-time
- Interact with (for HTML/JavaScript content)
- Copy to clipboard
- Download as files
- View in full-screen mode
- Open in new windows

## Supported Artifact Types

### 🌐 HTML Artifacts
Interactive web pages with full HTML, CSS, and JavaScript support.

**Example prompt:** "Create an interactive HTML page with a button that changes color when clicked"

**Automatically detected from:**
```html
<!DOCTYPE html>
<html>
<head>
    <title>Interactive Demo</title>
</head>
<body>
    <button onclick="changeColor()">Click Me!</button>
    <script>
        function changeColor() {
            this.style.backgroundColor = 'lightblue';
        }
    </script>
</body>
</html>
```

### 🎨 SVG Artifacts
Scalable vector graphics with support for animations and interactivity.

**Example prompt:** "Create an animated SVG logo for a tech company"

**Automatically detected from:**
```svg
<svg width="200" height="200" xmlns="http://www.w3.org/2000/svg">
    <circle cx="100" cy="100" r="50" fill="blue">
        <animate attributeName="r" values="50;70;50" dur="2s" repeatCount="indefinite"/>
    </circle>
</svg>
```

### 💻 Code Artifacts
Syntax-highlighted code snippets with language support.

**Supported languages:**
- Python
- JavaScript
- CSS
- JSON
- And many more...

**Example prompt:** "Write a Python function to process CSV data"

**Automatically detected from:**
```python
import pandas as pd

def process_csv(filename):
    df = pd.read_csv(filename)
    return df.describe()
```

### 📊 JSON Artifacts
Formatted and validated JSON data structures.

**Example prompt:** "Create a JSON configuration for a web app"

**Automatically detected from:**
```json
{
    "app": {
        "name": "MyApp",
        "version": "1.0.0",
        "features": ["auth", "chat", "artifacts"]
    }
}
```

## How Artifacts are Detected

### Automatic Detection
Artifacts are automatically detected when the AI returns code blocks with specific patterns:

1. **Language-based detection:** Code blocks with languages like `html`, `svg`, `python`, etc.
2. **Content analysis:** The system analyzes the content to determine if it should be rendered as an artifact
3. **Size thresholds:** Only substantial code blocks become artifacts (prevents small snippets from being rendered)

### Explicit Artifact Markers
You can also explicitly create artifacts using XML-style markers:

```xml
<artifact type="html" title="My Interactive Page">
    <h1>Hello World!</h1>
    <button onclick="alert('Hello!')">Click me</button>
</artifact>
```

## Security Features

### Sandboxed Rendering
- All HTML artifacts run in sandboxed iframes
- JavaScript execution is isolated from the main application
- No access to parent window or sensitive data

### Content Validation
- SVG content is validated before rendering
- JSON is parsed and validated
- Malicious content patterns are detected and blocked

### Safe Downloads
- Downloaded files are properly sanitized
- File extensions match content types
- No executable file downloads

## Interactive Features

### Full-Screen Mode
Click the maximize button to view artifacts in full-screen mode for better visibility and interaction.

### Copy & Download
- **Copy Button:** Copy the raw content to clipboard
- **Download Button:** Save the artifact as a file with appropriate extension
- **External Window:** Open HTML artifacts in a new browser window

### Real-Time Updates
Artifacts update in real-time as the AI generates content, allowing you to see the creation process.

## Best Practices

### For Users

1. **Be Specific:** Ask for specific types of content
   - ✅ "Create an interactive HTML form with validation"
   - ❌ "Make something interactive"

2. **Request Complete Examples:** Ask for fully functional code
   - ✅ "Create a complete HTML page with CSS styling"
   - ❌ "Show me some HTML"

3. **Iterate and Improve:** Ask for modifications to existing artifacts
   - "Add animations to the SVG logo"
   - "Make the HTML form responsive"

### For AI Responses

When generating artifacts, the AI should:
1. Create complete, functional code
2. Include proper structure (DOCTYPE for HTML, proper JSON syntax)
3. Add meaningful titles and descriptions
4. Ensure security best practices

## Examples

### Interactive Dashboard
```
Create an HTML dashboard that shows:
- Current time (updating every second)
- Weather widget (mock data)
- Task list with checkboxes
- Color theme switcher
```

### Data Visualization
```
Create an SVG chart showing:
- Bar chart with sample sales data
- Animated bars on load
- Hover effects showing exact values
- Legend with color coding
```

### Configuration Generator
```
Generate a JSON configuration for a chat application with:
- User settings (theme, notifications)
- Model configurations
- Plugin settings
- Feature flags
```

## Troubleshooting

### Artifact Not Appearing
- Ensure code blocks use proper language tags
- Check that content meets minimum size requirements
- Verify the code is syntactically correct

### Interactive Content Not Working
- Check browser console for JavaScript errors
- Ensure HTML structure is valid
- Verify that scripts are properly embedded

### Download Issues
- Check browser download settings
- Ensure pop-up blockers aren't interfering
- Try copying content manually if download fails

## Future Enhancements

- **React Components:** Support for interactive React components
- **Chart Libraries:** Integration with Chart.js, D3.js for data visualization
- **Mermaid Diagrams:** Automatic rendering of flowcharts and diagrams
- **LaTeX Math:** Mathematical notation rendering
- **3D Visualizations:** WebGL-based 3D content

The Artifacts feature brings your conversations to life by making code and content immediately interactive and useful. It's perfect for prototyping, learning, and creating shareable content within your AI conversations.
