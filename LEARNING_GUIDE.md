# 🎓 AI MI Learning Guide

## 📋 Daily Learning Checklist

### Week 1-2: Foundation
- [ ] **Day 1**: Learn React basics - components, props, state
- [ ] **Day 2**: Next.js fundamentals - App Router, pages, routing
- [ ] **Day 3**: TypeScript basics - types, interfaces, generics
- [ ] **Day 4**: Study the Prisma schema in `prisma/schema.prisma`
- [ ] **Day 5**: Understand the database models (Project, Message, Fragment, Usage)
- [ ] **Day 6**: Learn about Clerk authentication
- [ ] **Day 7**: Explore tRPC and API structure
- [ ] **Day 8**: Tailwind CSS fundamentals
- [ ] **Day 9**: Shadcn/UI component system
- [ ] **Day 10**: React Query for data fetching
- [ ] **Day 11-14**: Build small practice projects with these technologies

### Week 3-4: Project Deep Dive

#### 🏠 Home Module Analysis
**Files to study:**
- `src/modules/home/ui/components/project-form.tsx` - How projects are created
- `src/modules/home/ui/components/project-list.tsx` - How projects are displayed
- `src/app/(home)/page.tsx` - Main home page

**Key Questions to Answer:**
1. How does the project creation form work?
2. How are projects fetched and displayed?
3. What happens when a user submits a new project request?

#### 💬 Messages System Analysis
**Files to study:**
- `src/modules/messages/server/procedures.ts` - API endpoints for messages
- `src/modules/projects/ui/components/message-card.tsx` - Message display
- `src/modules/projects/ui/components/message-form.tsx` - Message input
- `src/modules/projects/ui/components/messages-container.tsx` - Message list

**Key Questions to Answer:**
1. How are messages stored in the database?
2. How does the chat interface work?
3. How are user messages processed?

#### 🤖 AI Processing System
**Files to study:**
- `src/inngest/functions.ts` - Main AI processing logic
- `src/inngest/utils.ts` - Helper functions
- `src/prompt.ts` - AI prompts and instructions

**Key Questions to Answer:**
1. How does the AI agent work?
2. What is E2B and how are sandboxes created?
3. How does code generation and execution work?
4. How are live previews generated?

#### 🗄️ Database & API Layer
**Files to study:**
- `src/trpc/routers/` - API route definitions
- `src/lib/db.ts` - Database connection
- `prisma/schema.prisma` - Database schema

### Week 5-6: Hands-On Practice

#### Setup Tasks
- [ ] Clone and run the project locally
- [ ] Set up environment variables
- [ ] Configure database connection
- [ ] Test the application end-to-end

#### Code Exploration Tasks
- [ ] Create a simple project through the UI
- [ ] Follow the code flow from frontend to backend
- [ ] Watch how messages are processed
- [ ] Observe sandbox creation and code execution
- [ ] Study the AI agent's responses

#### Modification Exercises
- [ ] Add a new field to the Project model
- [ ] Create a simple new component
- [ ] Modify the AI prompt
- [ ] Add basic logging to understand flow
- [ ] Customize the UI styling

## 🔍 Key Concepts to Master

### 1. **E2B Sandboxes**
- Isolated code execution environments
- How Next.js apps are created and run
- File system operations in sandboxes

### 2. **Inngest Framework**
- Background job processing
- Event-driven architecture
- AI agent orchestration

### 3. **AI Agent System**
- Code generation prompts
- Tool usage (terminal, file operations)
- Response processing and formatting

### 4. **Real-time Features**
- How updates flow from backend to frontend
- Message streaming and updates
- Live preview generation

## 📚 Recommended Learning Resources

### Documentation
1. [Next.js Documentation](https://nextjs.org/docs)
2. [Prisma Documentation](https://prisma.io/docs)
3. [tRPC Documentation](https://trpc.io)
4. [Clerk Documentation](https://clerk.com/docs)
5. [E2B Documentation](https://e2b.dev/docs)
6. [Inngest Documentation](https://inngest.com/docs)

### Video Resources
1. **Next.js 15 Crash Course** - YouTube
2. **TypeScript for React Developers** - YouTube
3. **Prisma ORM Tutorial** - YouTube
4. **tRPC Full Course** - YouTube

### Practice Projects
1. **Simple Todo App** with Next.js + Prisma
2. **Chat Application** with real-time features
3. **API with tRPC** for CRUD operations

## 🎯 Learning Milestones

### Milestone 1: Understanding the Stack
- Can explain what each technology does
- Understands the overall architecture
- Can navigate the codebase confidently

### Milestone 2: Code Flow Comprehension
- Can trace a feature from UI to database
- Understands how AI processing works
- Can explain the sandbox system

### Milestone 3: Hands-On Competency
- Can run the project locally
- Can make simple modifications
- Can debug basic issues

### Milestone 4: Advanced Understanding
- Can add new features
- Understands the AI agent system
- Can optimize and improve the code

## 🛠️ Debugging Tips

1. **Use Browser DevTools** - Inspect network requests, console logs
2. **Database Inspection** - Use Prisma Studio to view data
3. **API Testing** - Test tRPC procedures directly
4. **Log Analysis** - Add console.log statements strategically
5. **Error Boundaries** - Understand React error handling

## 📝 Study Notes Template

For each file you study, ask yourself:
1. **What does this file do?**
2. **How does it connect to other parts?**
3. **What would break if I removed this?**
4. **How could I improve or extend this?**

Keep notes on:
- Key functions and their purposes
- Data flow patterns
- API endpoints and their uses
- Component hierarchies and props
- Database relationships

## 🎉 Final Project Ideas

Once you understand the codebase, try building:

1. **Enhanced AI Features**
   - Add support for different programming languages
   - Implement code review and suggestions
   - Add project templates

2. **Improved User Experience**
   - Better error handling and messaging
   - Progress indicators for AI processing
   - Enhanced project management features

3. **Additional Integrations**
   - GitHub integration for code saving
   - Deployment features
   - Collaboration features

Remember: The goal is not just to understand this specific project, but to learn the patterns and technologies that you can apply to build your own amazing applications!
