# Stage 1: Dependencies
FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN apk add --no-cache python3 make g++ \
    && npm ci --omit=dev

# Stage 2: Build
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN apk add --no-cache python3 make g++ \
    && npm ci
COPY . .
RUN npm run build

# Stage 3: Production
FROM node:22-alpine AS production

# Install tini for proper signal handling
RUN apk add --no-cache tini

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 -G nodejs

WORKDIR /app

# Copy production dependencies
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./

# Create data directory
RUN mkdir -p /app/data && chown -R nodejs:nodejs /app

USER nodejs

# Use tini as init process
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
