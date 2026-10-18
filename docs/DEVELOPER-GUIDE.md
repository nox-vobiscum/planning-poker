# Developer Guide

Complete guide for developers working on the RBS' Planning Poker project.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Local Development Setup](#local-development-setup)
3. [Project Structure](#project-structure)
4. [Development Workflow](#development-workflow)
5. [Building](#building)
6. [Testing](#testing)
7. [Debugging](#debugging)
8. [Common Tasks](#common-tasks)
9. [Troubleshooting](#troubleshooting)

---

## Prerequisites

### Required Tools

- **Java 25** (OpenJDK or Oracle JDK)
- **Maven 3.x** (or use included Maven Wrapper)
- **Git** (for version control)
- **Node.js 18+** (for Playwright tests only)
- **npm** (bundled with Node.js)

### Optional Tools

- **IntelliJ IDEA** or **VS Code** (recommended IDEs)
- **Docker** (for containerized development)
- **Git Bash** (on Windows)

### Verify Installation

```bash
# Java
java -version
# Should show: openjdk version "25..." or similar

# Maven
mvn -v
# Or use Maven Wrapper:
./mvnw -v

# Node.js (for E2E tests)
node -v
npm -v

# Git
git --version
```

---

## Local Development Setup

### 1. Clone the Repository

```bash
git clone https://github.com/nox-vobiscum/planning-poker.git
cd planning-poker
```

### 2. Configuration

**Default configuration** (`src/main/resources/application.properties`) works out of the box.

**Key settings for local dev:**
```properties
# Persistence disabled (in-memory only)
features.persistentRooms.enabled=false

# WebSocket origins (includes localhost)
app.websocket.allowed-origins=http://localhost:*,http://127.0.0.1:*
```

**Optional:** Create `application-local.properties` for local overrides:
```properties
# Example: enable debug logging
logging.level.com.example.planningpoker=DEBUG

# Example: enable FTPS persistence
features.persistentRooms.enabled=true
app.storage.ftps.host=localhost
app.storage.ftps.port=2121
```

### 3. Install Dependencies

**Backend (Maven):**
```bash
./mvnw dependency:go-offline
```

**Frontend (npm - for E2E tests only):**
```bash
npm ci
npx playwright install --with-deps
```

---

## Project Structure

```
planning-poker/
├── .github/               # GitHub workflows (CI/CD)
├── .githooks/             # Git hooks
├── docs/                  # Documentation
│   ├── adr/               # Architecture Decision Records
│   ├── ARCHITECTURE.md    # System architecture
│   ├── API.md             # API reference
│   ├── BRIEFING.md        # Project overview
│   ├── E2E-TESTING.md     # Testing guide
│   ├── STYLE.md           # UI style guide
│   └── BACKLOG.md         # Future work
├── scripts/               # Utility scripts
├── src/
│   ├── main/
│   │   ├── java/
│   │   │   └── com/example/planningpoker/
│   │   │       ├── config/          # Configuration classes
│   │   │       ├── controller/      # HTTP controllers
│   │   │       ├── handler/         # WebSocket handler
│   │   │       ├── model/           # Domain models
│   │   │       ├── persistence/     # Persistence layer
│   │   │       ├── rooms/           # Room-related services
│   │   │       ├── security/        # Security utilities
│   │   │       ├── service/         # Business logic
│   │   │       ├── storage/         # Storage implementations
│   │   │       └── web/             # Additional web controllers
│   │   └── resources/
│   │       ├── static/              # Static assets
│   │       │   ├── js/              # JavaScript modules
│   │       │   ├── flags/           # Flag icons
│   │       │   ├── styles.css       # Main stylesheet
│   │       │   └── favicon.*        # Favicons
│   │       ├── templates/           # Thymeleaf templates
│   │       │   ├── fragments/       # Reusable fragments
│   │       │   ├── index.html       # Home page
│   │       │   ├── invite.html      # Join/create form
│   │       │   └── room.html        # Poker room
│   │       ├── application*.properties  # Configuration
│   │       └── messages*.properties     # i18n messages
│   └── test/
│       └── java/                    # JUnit tests
├── tests/                 # Playwright E2E tests
│   ├── utils/             # Test helpers
│   └── *.spec.ts          # Test specs
├── Dockerfile             # Docker multi-stage build
├── koyeb.yaml             # Koyeb deployment config
├── pom.xml                # Maven configuration
├── package.json           # npm configuration (E2E tests)
├── playwright.config.ts   # Playwright configuration
└── README.md              # Project readme
```

---

## Development Workflow

### Starting the Application

#### Option 1: Maven Spring Boot Plugin (Recommended)
```bash
./mvnw spring-boot:run
```

**With profile:**
```bash
./mvnw spring-boot:run -Dspring-boot.run.profiles=local
```

**With debug port:**
```bash
./mvnw spring-boot:run -Dspring-boot.run.jvmArguments="-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005"
```

#### Option 2: Run JAR
```bash
./mvnw package -DskipTests
java -jar target/planningpoker-*.jar
```

#### Option 3: IDE
- **IntelliJ IDEA:** Right-click `PlanningPokerApplication.java` → Run
- **VS Code:** Use "Run Java" or "Debug Java" CodeLens

**Application URL:** http://localhost:8080

---

### Hot Reload / Dev Tools

Spring Boot DevTools is included (auto-restart on file changes).

**Trigger restart:**
- Save a `.java` file (IntelliJ: auto-build)
- Run Maven compile: `./mvnw compile`

**Static resources** (JS, CSS, HTML):
- Changes picked up immediately (no restart needed)
- Refresh browser to see changes

---

### Coding Standards

See [BRIEFING.md § 4 "Coding & Style Rules"](BRIEFING.md#4-coding--style-rules).

**Key Points:**
- English everywhere (code, comments, commit messages)
- Small, focused changes
- Reuse first (extend existing files)
- All CSS in `static/styles.css` (no inline styles)
- Follow existing patterns

---

### Git Workflow

**Branching:**
```bash
# Create feature branch
git checkout -b feature/my-feature

# Work on feature
git add .
git commit -m "Add feature X"

# Push to origin
git push -u origin feature/my-feature
```

**Pull Requests:**
- Create PR from feature branch to `main`
- Use PR template (`.github/pull_request_template.md`)
- Wait for CI checks to pass
- Request review

**Commit Messages:**
- Use clear, descriptive messages
- Start with verb (Add, Fix, Update, Refactor)
- Reference issues if applicable

---

## Building

### Full Build
```bash
./mvnw clean package
```

**Output:** `target/planningpoker-1.4.0-SNAPSHOT.jar`

### Skip Tests
```bash
./mvnw package -DskipTests
```

### Clean Build
```bash
./mvnw clean install
```

### Build for Specific Profile
```bash
./mvnw package -P prod
```

---

## Testing

### Unit Tests (JUnit)

**Run all tests:**
```bash
./mvnw test
```

**Run specific test class:**
```bash
./mvnw test -Dtest=GameServiceTest
```

**Run specific test method:**
```bash
./mvnw test -Dtest=GameServiceTest#testJoinRoom
```

**Coverage report:**
```bash
./mvnw test jacoco:report
# Report: target/site/jacoco/index.html
```

---

### E2E Tests (Playwright)

See [E2E-TESTING.md](E2E-TESTING.md) for detailed guide.

**Prerequisites:**
```bash
npm ci
npx playwright install --with-deps
```

**Start application:**
```bash
# Terminal 1: Start app
./mvnw spring-boot:run -Dspring-boot.run.profiles=e2e

# Or use E2E profile with JAR:
java -jar target/planningpoker-*.jar --spring.profiles.active=e2e
```

**Run tests:**
```bash
# Terminal 2: Run tests
PP_BASE_URL=http://localhost:8080 npx playwright test
```

**Run specific test:**
```bash
PP_BASE_URL=http://localhost:8080 npx playwright test tests/cards-reveal.spec.ts
```

**Headed mode (see browser):**
```bash
PP_BASE_URL=http://localhost:8080 npx playwright test --headed
```

**Debug mode:**
```bash
PP_BASE_URL=http://localhost:8080 npx playwright test --debug
```

**UI mode (interactive):**
```bash
PP_BASE_URL=http://localhost:8080 npx playwright test --ui
```

**View test report:**
```bash
npx playwright show-report
```

---

### Guardrail Scripts

**Check menu toggle events:**
```bash
npm run check:menu-events
```

**Check E2E helpers:**
```bash
npm run check:e2e:helpers
```

**Run all checks:**
```bash
npm run check
```

---

## Debugging

### Backend Debugging

#### IntelliJ IDEA
1. Right-click `PlanningPokerApplication.java`
2. Select "Debug 'PlanningPokerApplication'"
3. Set breakpoints in code

#### VS Code
1. Install "Debugger for Java" extension
2. Use CodeLens "Debug" or F5
3. Set breakpoints

#### Remote Debugging (Running JAR)
```bash
java -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005 -jar target/planningpoker-*.jar
```

**Attach debugger to port 5005.**

---

### Frontend Debugging

**Browser DevTools:**
- Open Chrome/Edge DevTools (F12)
- Sources tab → `js/room.js`
- Set breakpoints
- Inspect WebSocket frames (Network → WS)

**Console Logging:**
```javascript
// room.js includes logging
console.log('[ROOM]', 'message');
```

---

### WebSocket Debugging

**Chrome DevTools:**
1. Network tab → WS filter
2. Click on `/gameSocket` connection
3. View frames (Messages tab)

**curl WebSocket test:**
```bash
wscat -c ws://localhost:8080/gameSocket
# Type: {"version":2,"type":"newJoin","roomCode":"demo","participantName":"DevBot"}
# Persist the identityGrant token securely, then type: identityAck
```

Do not paste production proof tokens into terminals, screenshots, issues or logs.
The browser client also answers server `identityChallenge` frames and is the
reference implementation for authenticated resume.

**Install wscat:**
```bash
npm install -g wscat
```

---

### Logging Levels

**application.properties:**
```properties
# Debug specific package
logging.level.com.example.planningpoker=DEBUG

# Debug all packages
logging.level.root=DEBUG

# Specific class
logging.level.com.example.planningpoker.service.GameService=TRACE
```

**Temporary (via JVM args):**
```bash
java -Dlogging.level.com.example.planningpoker=DEBUG -jar target/planningpoker-*.jar
```

---

## Common Tasks

### Add a New Card Sequence

1. **Update `CardSequences.java`:**
```java
public static final List<String> MY_SEQUENCE = List.of("A", "B", "C");
private static final Map<String, List<String>> ALL_SEQUENCES = Map.of(
    "fib", FIBONACCI,
    "my-seq", MY_SEQUENCE  // Add here
);
```

2. **Test:**
```bash
curl http://localhost:8080/api/sequences
```

---

### Add a New Special Card

1. **Update `CardSequences.java`:**
```java
public static final List<String> SPECIALS = List.of("❓", "☕", "🎯");  // Add emoji
```

2. **Update `room.js` and `menu.js`:**
```javascript
const SPECIALS_ICON_BY_ID = {
  coffee: '☕',
  target: '🎯'  // Add ID mapping
};
const SPECIALS_ORDER = ['coffee', 'target'];
```

---

### Add a New REST Endpoint

1. **Create controller:**
```java
@RestController
@RequestMapping("/api")
public class MyController {
    
    @GetMapping("/hello")
    public Map<String, String> hello() {
        return Map.of("message", "Hello, World!");
    }
}
```

2. **Test:**
```bash
curl http://localhost:8080/api/hello
```

---

### Add a New WebSocket Message Type

1. **Update the authenticated command path:**

Keep admission, proof validation and ownership fencing in
`IdentityWebSocketHandler`. Add participant/host commands to the delegated
`GameWebSocketHandler` only after authentication; never parse identity from a name
or client-supplied ID.

```java
if (payload.startsWith("myCommand:")) {
    String arg = payload.substring("myCommand:".length());
    // Handle command
    return;
}
```

2. **Update `room.js`:**
```javascript
function myCommand(arg) {
    send(`myCommand:${arg}`);
}
```

---

### Add i18n Messages

1. **Update `messages.properties` (English):**
```properties
my.key=Hello
```

2. **Update `messages_de.properties` (German):**
```properties
my.key=Hallo
```

3. **Use in template:**
```html
<span th:text="#{my.key}">Hello</span>
```

4. **Use in JavaScript:**
```javascript
const msg = t('my.key', 'Hello');
```

---

### Enable FTPS Persistence

1. **Configure credentials** (env vars or properties):
```bash
export DF_FTP_HOST=ftp.example.com
export DF_FTP_USER=myuser
export DF_FTP_PASS=mypassword
```

2. **Enable feature:**
```properties
features.persistentRooms.enabled=true
```

3. **Test connection:**
```bash
curl http://localhost:8080/api/storage/probe
# (if diagnostic endpoints enabled)
```

---

## Troubleshooting

### Port 8080 Already in Use

**Windows (PowerShell):**
```powershell
# Find process
Get-Process -Id (Get-NetTCPConnection -LocalPort 8080).OwningProcess

# Kill process
Stop-Process -Id <PID>

# Or use provided script:
.\kill-8080.ps1
```

**Linux/Mac:**
```bash
lsof -ti:8080 | xargs kill -9
```

---

### WebSocket Connection Fails

**Check allowed origins:**
```properties
app.websocket.allowed-origins=http://localhost:*,http://127.0.0.1:*
```

**Check browser console:**
- Look for CORS errors
- Verify WebSocket URL (`ws://` vs. `wss://`)

---

### Tests Fail

**Unit tests:**
```bash
# Clean and rebuild
./mvnw clean test

# Skip specific test
./mvnw test -Dtest=!FailingTest
```

**E2E tests:**
```bash
# Check app is running
curl http://localhost:8080/healthz

# Run with trace
PP_BASE_URL=http://localhost:8080 npx playwright test --trace=on

# View trace
npx playwright show-trace trace.zip
```

---

### Hot Reload Not Working

**IntelliJ IDEA:**
- Enable "Build project automatically" (Settings → Build, Execution, Deployment → Compiler)
- Enable "Allow auto-make to start even if developed application is running" (Settings → Advanced Settings)

**VS Code:**
- Save files to trigger recompile
- Check Java extension logs

---

### Maven Wrapper Issues

**Permissions (Linux/Mac):**
```bash
chmod +x mvnw
```

**Re-download wrapper:**
```bash
mvn wrapper:wrapper
```

---

### Docker Build Fails

**Windows line endings:**
```bash
# Convert mvnw to Unix line endings
dos2unix mvnw

# Or in Dockerfile:
RUN sed -i 's/\r$//' mvnw && chmod +x mvnw
```

**Network issues:**
```bash
# Build with host network
docker build --network=host -t planning-poker .
```

---

### Out of Memory

**Increase heap size:**
```bash
java -Xmx512m -jar target/planningpoker-*.jar
```

**Or in Maven:**
```bash
./mvnw spring-boot:run -Dspring-boot.run.jvmArguments="-Xmx512m"
```

---

## Performance Profiling

### JVM Profiling

**Enable JMX:**
```bash
java -Dcom.sun.management.jmxremote \
     -Dcom.sun.management.jmxremote.port=9010 \
     -Dcom.sun.management.jmxremote.authenticate=false \
     -Dcom.sun.management.jmxremote.ssl=false \
     -jar target/planningpoker-*.jar
```

**Connect with JConsole/VisualVM:**
```bash
jconsole localhost:9010
```

---

### Actuator Endpoints

**Enable Actuator:**
```properties
management.endpoints.web.exposure.include=health,metrics,info
```

**Check metrics:**
```bash
curl http://localhost:8080/actuator/metrics
curl http://localhost:8080/actuator/metrics/jvm.memory.used
```

---

## IDE Setup

### IntelliJ IDEA

**Import Project:**
1. File → Open → Select `pom.xml`
2. Trust project

**Configure SDK:**
1. File → Project Structure → Project
2. Set SDK to Java 25

**Run Configuration:**
- Main class: `com.example.planningpoker.PlanningPokerApplication`
- Working directory: `$MODULE_WORKING_DIR$`
- Use classpath of module: `planningpoker`

---

### VS Code

**Extensions:**
- Extension Pack for Java
- Spring Boot Extension Pack
- Playwright Test for VSCode

**Launch configuration (`.vscode/launch.json`):**
```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "java",
      "name": "PlanningPokerApplication",
      "request": "launch",
      "mainClass": "com.example.planningpoker.PlanningPokerApplication",
      "projectName": "planningpoker"
    }
  ]
}
```

---

## Additional Resources

- [ARCHITECTURE.md](ARCHITECTURE.md) - System architecture
- [API.md](API.md) - API reference
- [BRIEFING.md](BRIEFING.md) - Project overview
- [E2E-TESTING.md](E2E-TESTING.md) - Testing guide
- [STYLE.md](STYLE.md) - UI style guide
- [BACKLOG.md](BACKLOG.md) - Future work

**External Documentation:**
- [Spring Boot Reference](https://docs.spring.io/spring-boot/docs/current/reference/html/)
- [Thymeleaf Documentation](https://www.thymeleaf.org/documentation.html)
- [Playwright Documentation](https://playwright.dev/)

---

## Getting Help

1. Check existing documentation in `docs/`
2. Search GitHub issues
3. Review code comments and JavaDoc
4. Ask in team chat/Slack
5. Create a GitHub issue (use templates)

---

## Contributing

See [BRIEFING.md § 5 "Collaboration Workflow"](BRIEFING.md#5-collaboration-workflow-dev--ai) for contribution guidelines.

**Quick checklist:**
- [ ] Code follows project conventions
- [ ] Tests pass (`mvnw test`)
- [ ] E2E tests pass (if applicable)
- [ ] Documentation updated
- [ ] Commit messages are clear
- [ ] PR uses template
