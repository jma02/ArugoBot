const userOption = (name: string, description: string) => ({ type: 6, name, description });
const pageOption = { type: 4, name: "page", description: "Page number", min_value: 1, max_value: 1000 };
const opponents = Array.from({ length: 4 }, (_, index) =>
  userOption(`opponent${index + 1}`, `Additional participant ${index + 1}`));

export const COMMANDS = [
  { name: "ping", description: "Check whether ArugoBot is responding." },
  { name: "help", description: "Show ArugoBot's commands." },
  {
    name: "register", description: "Link your Codeforces handle by verifying a submission.",
    options: [{ type: 3, name: "handle", description: "Your Codeforces handle", required: true, max_length: 24 }],
  },
  { name: "unlink", description: "Unlink your handle and erase your ArugoBot rating and history." },
  {
    name: "challenge", description: "Start a rated Codeforces challenge with up to five people.",
    options: [
      { type: 3, name: "problem", description: "Problem ID (1000A) or rating (1500)", required: true, max_length: 16 },
      {
        type: 4, name: "minutes", description: "Challenge duration", required: true,
        choices: [40, 60, 80, 100, 120].map((value) => ({ name: `${value} minutes`, value })),
      },
      ...opponents,
    ],
  },
  {
    name: "suggest", description: "Find problems that none of the selected participants have solved.",
    options: [
      { type: 4, name: "rating", description: "Problem rating (a multiple of 100)", required: true, min_value: 800, max_value: 3500 },
      ...opponents,
    ],
  },
  {
    name: "rating", description: "Show a rating graph.",
    options: [userOption("user", "Whose rating to show (defaults to you)")],
  },
  {
    name: "history", description: "Show challenge history and rating changes.",
    options: [userOption("user", "Whose history to show (defaults to you)"), pageOption],
  },
  { name: "leaderboard", description: "Show this server's ArugoBot rankings.", options: [pageOption] },
].map((command) => ({ ...command, type: 1, contexts: [0], integration_types: [0] }));
