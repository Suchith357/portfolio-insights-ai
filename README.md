# Portfolio Insights AI

PORTFOLIOIQ — INITIAL APPLICATION BUILD

Build a professional full-stack web application called:

PortfolioIQ — AI-Powered Stock Portfolio Risk & Diversification Analyzer

This is a Database Systems academic project and a serious resume project.

IMPORTANT — READ BEFORE BUILDING

Do NOT create a simple CRUD stock application.

The product vision is:

A portfolio-aware investment analysis platform where users can manage portfolios, analyze their risk and diversification, investigate stocks using historical data, simulate buying or selling stocks, and receive AI-assisted explanations based on their portfolio.

The application must be designed so that the PostgreSQL database and Node.js backend will become the core of the system.

TECHNOLOGY

Use:

React

TypeScript

Node.js

Express.js

PostgreSQL

Prisma ORM

JWT authentication

bcrypt password hashing

Do not introduce a different primary stack.

The frontend must communicate with the backend through REST APIs.

Do not connect React directly to PostgreSQL.

IMPORTANT DATABASE INSTRUCTION

Do NOT invent a final database schema yet.

The database will be designed separately from the application using:

ER diagram

Relational schema

3NF normalization

Data dictionary

Primary keys

Foreign keys

Constraints

Indexes

The eventual database will contain at least 8 related tables.

Candidate conceptual entities may include:

Users

Roles

Portfolios

Stocks

Sectors

Holdings

Transactions

Watchlists

Historical Prices

Portfolio Analyses

Risk Metrics

News Events

Alerts

Audit Logs

These are NOT instructions to blindly create all of these tables.

The final schema will be determined from the ER diagram.

APPLICATION USERS

There are two roles:

USER

A normal user can:

Register

Login

Logout

Manage profile

Create portfolios

Edit portfolios

Delete portfolios

View portfolios

Manage holdings

Record buy transactions

Record sell transactions

View transaction history

Search stocks

Analyze stocks

Simulate adding stocks

Analyze existing holdings

Simulate selling holdings

View risk

View diversification

Manage watchlist

View alerts

View AI insights

ADMIN

Admin can additionally:

View users

Manage users

View stock data

View system statistics

View audit information

There must NOT be separate Admin and User database tables.

The eventual database will use a single Users table with role information.

REQUIRED PAGES

Create these pages and routes.

Public

Landing Page

Create a polished fintech landing page.

Include:

PortfolioIQ logo/branding

Hero section

Short product description

Risk analysis explanation

Diversification explanation

Stock analysis explanation

AI insights explanation

News alert explanation

Call-to-action buttons

Login

Register

Do NOT make unsupported claims such as guaranteed profits.

Login

Fields:

Email

Password

Include:

Validation

Loading state

Error state

Login button

Link to registration

Registration

Fields:

Name

Email

Password

Confirm password

Include proper validation.

USER DASHBOARD

Create a professional financial dashboard.

Display:

Total Portfolio Value

Total Investment

Profit/Loss

Risk Score

Diversification Score

Sector Allocation

Stock Allocation

Portfolio Performance

Recent Transactions

Important Alerts

AI Insights

Use appropriate charts and visualizations.

The dashboard should feel like a serious fintech analytics product.

PORTFOLIOS

Create a portfolio management page.

Users should be able to:

Create portfolio

Edit portfolio

Delete portfolio

Open portfolio

View portfolio summary

Portfolio details should contain:

Overview

Total value

Investment

Profit/Loss

Risk

Diversification

Holdings

Stock

Quantity

Average purchase price

Current/available price

Current value

Profit/Loss

Allocation %

Transactions

Buy/Sell

Stock

Quantity

Price

Date

Transaction value

STOCK EXPLORER

Create a stock search/explorer page.

Include:

Search

Filtering

Sorting

Pagination

Stock cards/table

Stock symbol

Company name

Sector

Available price information

Clicking a stock should open its detailed analysis.

Do not fabricate live financial information.

If real market data is not connected yet, clearly label data as demo/sample data.

STOCK DETAILS

Create a professional stock detail page.

Include:

Stock name

Symbol

Sector

Available current price

Historical price chart

Historical performance

Volatility

Risk information

Provide a prominent:

Analyze Against My Portfolio

button.

STOCK ANALYSIS

This is one of the most important PortfolioIQ features.

When a user searches for a stock they are interested in, PortfolioIQ should analyze the stock AND compare it with their existing portfolio.

Historical Analysis

Display:

Historical price chart

Available 1-year performance

Available 3-year performance

Available 5-year performance

Volatility

Drawdown

Historical risk

Only display metrics when the required data exists.

PORTFOLIO COMPARISON

Compare:

Candidate Stock

against:

User's Current Portfolio

Show:

Sector overlap

Existing exposure

Concentration impact

Diversification impact

Risk impact

Correlation when sufficient data exists

BUY SIMULATION

Allow the user to enter:

Candidate stock

Hypothetical investment amount

Example:

TCS
₹50,000

This MUST be a simulation.

It must NOT modify the real portfolio.

Show:

Current Portfolio

Risk score

Diversification score

Sector allocation

Stock concentration

Simulated Portfolio

Risk score

Diversification score

Sector allocation

Stock concentration

Difference

Show how the hypothetical investment changes the portfolio.

Finally provide:

Portfolio Fit Score

Example:

7.4 / 10

Possible classification:

Strong Fit

Reasonable Fit

Weak Fit

Poor Fit

The exact score calculation will be implemented later in the analytics engine.

HOLDING ANALYSIS

For stocks already owned by the user, create a detailed holding-analysis experience.

Show:

Current quantity

Average purchase price

Current value

Profit/Loss

Allocation

Historical performance

Risk

Allow simulation of:

Sell 10%

Sell 25%

Sell 50%

Sell 75%

Sell 100%

Custom percentage

This is ONLY a simulation.

It must NOT create an actual transaction.

Compare:

Before Sale

Portfolio value

Risk

Diversification

Sector exposure

Stock concentration

After Simulated Sale

Portfolio value

Risk

Diversification

Sector exposure

Stock concentration

Then produce:

HOLD

REVIEW

CONSIDER REDUCING

Do NOT claim certainty about future prices.

Use wording such as:

"Current indicators suggest elevated risk."

rather than:

"This stock will definitely fall."

NEWS AND RISK ALERTS

Create an Alerts page.

The system should eventually support monitoring relevant news for stocks owned by the user.

Each alert should show:

Stock

Headline

Event type

Severity

Timestamp

Summary

Source

User's portfolio exposure

Why the event may matter

Severity levels:

LOW

MEDIUM

HIGH

CRITICAL

High-severity alerts should be visually prominent.

Do not claim that a news event guarantees a future loss.

AI INSIGHTS

Create an AI Insights section throughout the application.

AI should explain structured calculations.

The AI may receive:

Risk score

Diversification score

Sector allocation

Stock concentration

Historical performance

Simulation results

News classification

The AI should NOT invent numerical financial data.

The analytics engine calculates numbers.

The AI explains the numbers.

The AI integration must be replaceable and must NOT require a paid API for the core application.

Do not hardcode API keys.

WATCHLIST

Create a Watchlist page.

Users can:

Add stocks

Remove stocks

Search

Filter

View saved stocks

ADMIN DASHBOARD

Create a separate protected admin area.

Include:

Overview

Total users

Total portfolios

Total holdings

Total transactions

Number of alerts

User Management

User list

Search

Filter

Pagination

Role information

Account status

Stock/Data Management

Provide a management interface for stock data.

Audit Information

Create a professional audit-log interface.

NAVIGATION

For normal users:

Dashboard
Portfolios
Stock Explorer
Watchlist
Alerts
Profile

For admins:

Dashboard
Portfolios
Stock Explorer
Watchlist
Alerts
Admin

Do not display admin navigation to normal users.

However, hiding navigation is NOT sufficient authorization.

The backend must eventually enforce authorization.

DESIGN

Create a modern fintech design.

The product should feel similar in quality to professional financial analytics software.

Use:

Responsive layout

Professional typography

Clean cards

Charts

Data tables

Tabs

Search bars

Filters

Badges

Toasts

Modal dialogs

Loading skeletons

Empty states

Error states

Confirmation dialogs

Use a consistent visual language throughout the entire application.

Avoid excessive gradients, animations, or decorative elements.

Prioritize readability of financial information.

RESPONSIVENESS

The application must work properly on:

Desktop

Laptop

Tablet

Mobile

Do not simply scale the desktop layout down.

Tables and charts must remain usable on smaller screens.

VALIDATION

Implement frontend validation for:

Login

Registration

Portfolio forms

Holding forms

Transaction forms

Simulation inputs

Search inputs

Never rely exclusively on frontend validation.

Backend validation will also be implemented later.

ERROR STATES

Create proper UI states for:

Loading

Empty data

Invalid input

Authentication failure

Unauthorized access

Not found

Server failure

Network failure

Do not expose internal errors or database details to users.

ARCHITECTURE

Keep the code modular.

Frontend:

components
pages
layouts
hooks
services
types
utils

Backend:

routes
controllers
services
middleware
validators
utils

Business logic should NOT be placed directly inside React components.

Database logic should NOT be placed directly inside Express route definitions.

API ARCHITECTURE

The frontend should be designed to communicate with REST endpoints.

Potential endpoint structure:

/api/auth
/api/users
/api/portfolios
/api/holdings
/api/transactions
/api/stocks
/api/watchlist
/api/analysis
/api/alerts
/api/admin

These are conceptual endpoint groups.

Implement them cleanly and consistently.

SECURITY

Prepare the project for:

JWT authentication
bcrypt password hashing
Protected routes
Role-based authorization
Input validation
Secure environment variables

Never hardcode:

Database passwords

JWT secrets

API keys

External service credentials

Create:

.env.example

Do NOT create or commit actual secrets.

ENVIRONMENT

Use environment variables for configuration.

Example:

DATABASE_URL
JWT_SECRET
API_BASE_URL
AI_API_KEY

Only placeholders should exist in .env.example.

GIT

The project will be maintained using GitHub.

Expected branches:

main
dev

Development will primarily happen on dev.

Do not generate fake Git commits.

Do not attempt to manipulate GitHub history.

The developer will handle Git operations separately.

DATABASE

PostgreSQL will be the final database.

Prisma will be the ORM.

Do not finalize the database schema independently.

Do not create arbitrary tables simply to reach a table count.

The database will later be designed from:

ER Diagram
→ Relational Schema
→ 3NF
→ PostgreSQL

The application should be written so this database can be integrated cleanly.

IMPORTANT DATABASE FEATURES TO SUPPORT LATER

The final system will demonstrate:

CRUD

JOINs

Aggregate queries

Views

Transactions

PostgreSQL triggers

PostgreSQL stored functions/procedures

Indexes

Do not fake these features in the frontend.

DATA

Do not fabricate live stock/news data.

If sample data is needed for the UI, clearly identify it as:

"Demo Data"

The architecture must allow a real data ingestion layer to be connected later.

₹0 REQUIREMENT

The project must target a ₹0 budget.

Do not make paid APIs or paid services mandatory.

The core application must function without a paid AI API.

External market data, news data and AI integrations must be replaceable.

Use free/open-source tools and free tiers wherever practical.

DOCKER

Prepare the project so it can eventually support:

frontend
backend
postgres

through Docker/Docker Compose.

Do not prioritize deployment before the application architecture is stable.

IMPORTANT SCOPE RULE

Do not try to implement every advanced database and AI feature in this first generation.

For this initial build:

Create the professional React application.

Create the page structure.

Create the navigation.

Create reusable UI components.

Create realistic demo/sample data clearly labeled as demo data.

Create frontend state/data abstractions that can later connect to the Express API.

Create the Express backend foundation.

Create clean API route structure.

Prepare Prisma integration without inventing the final schema.

Prepare authentication architecture.

Make the project easy to extend.

The database architecture, ER diagram, normalization, advanced PostgreSQL SQL, triggers, stored functions, indexes, backup/restore, security hardening, real data ingestion, AI integration, testing, Docker and deployment will be implemented and reviewed separately.

QUALITY STANDARD

Before considering the initial build complete, check:

All required pages exist.

Navigation works.

Protected/admin areas are represented correctly.

Forms have validation.

Loading/empty/error states exist.

The UI is responsive.

Stock analysis has a clear workflow.

Buy simulation is clearly separated from actual transactions.

Sell simulation is clearly separated from actual transactions.

AI insights are clearly separated from raw analytics.

No paid API is required.

No secrets are hardcoded.

No live data is falsely represented.

Code is modular and maintainable.

The project can later connect cleanly to PostgreSQL through Prisma.

Build the initial PortfolioIQ application carefully and professionally.
Do not simplify the project into a generic CRUD dashboard.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/7dc0068d-5867-409c-bd66-eb2b9ae32531).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
