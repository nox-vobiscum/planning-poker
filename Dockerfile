FROM maven:3.9.11-eclipse-temurin-25 AS build

WORKDIR /app

# Nur Dependencies laden (beschleunigt Builds)
COPY .mvn/ .mvn/
COPY mvnw .
COPY pom.xml .

# mvnw ausführbar machen (wichtig bei Windows-Hosts!)
RUN chmod +x ./mvnw && ./mvnw dependency:go-offline

# Jetzt Quellcode kopieren
COPY src ./src

# App bauen
RUN ./mvnw package -DskipTests

# --- RUNTIME STAGE ---
FROM eclipse-temurin:25-jre-alpine

WORKDIR /app

# curl für HEALTHCHECK installieren (Alpine)
RUN apk add --no-cache curl

# App-JAR aus Build-Stage kopieren
COPY --from=build /app/target/*.jar app.jar

EXPOSE 8080

ENTRYPOINT ["java", "-jar", "app.jar"]

# Container-Healthcheck: Homepage muss 200 liefern
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/ || exit 1
