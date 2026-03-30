---
description: How to add a new project page to the portfolio
---

# Adding a New Project Page

When instructed to add a new project to the portfolio, follow these steps to ensure consistency with the existing architecture:

1. **Create the Project Directory**
   Create a new directory in the root folder with the project name in lowercase (e.g., `newproject/`).

2. **Create the HTML File**
   Create an `index.html` file inside the new project directory.
   - Use `index.html` from the root or an existing project (like `aboutme/index.html`) as a template.
   - Retain the base `head` tags including fonts (`Play`, `Plus Jakarta Sans`, `Press Start 2P`) and SEO `meta` tags.
   - Update the `<title>`, description, OpenGraph, and Twitter card tags to reflect the new project.

3. **Styling and Assets**
   - Stick to inline `<style>` blocks or existing CSS patterns. Do not use external CSS frameworks like Tailwind or Bootstrap.
   - If there are images, put them in an `assets/` folder inside the project directory or link to existing CDN URLs if prompted.
   - The design should match the overall `#11071f` dark space theme with neon purple accents (`#7127ba`, `#4f228d`).

4. **Update the Main Page**
   - Add a link to the new project inside the root `index.html` page's project list/grid.
   - Ensure the thumbnail looks consistent with the others.

5. **Testing**
   - Verify there are no broken links.
   - Validate that the file path references are relative and correct.
