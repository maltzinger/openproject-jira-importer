require("dotenv").config();
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// OpenProject API configuration
const openProjectConfig = {
  baseURL: `${process.env.OPENPROJECT_HOST}/api/v3`,
  headers: {
    Authorization: `Basic ${Buffer.from(
      `apikey:${process.env.OPENPROJECT_API_KEY}`
    ).toString("base64")}`,
    "Content-Type": "application/json",
  },
};

const openProjectApi = axios.create(openProjectConfig);

// Jira API configuration
const jiraConfig = {
  baseURL: `https://${process.env.JIRA_HOST}/rest/api/3`,
  auth: {
    username: process.env.JIRA_EMAIL,
    password: process.env.JIRA_API_TOKEN,
  },
};

const jiraApi = axios.create(jiraConfig);

async function getJiraUsers() {
  try {
    console.log("\nFetching Jira users...");
    const response = await jiraApi.get("/users/search", {
      params: {
        maxResults: 1000,
      },
    });
    return response.data.map((user) => ({
      accountId: user.accountId,
      displayName: user.displayName,
      emailAddress: user.emailAddress,
      active: user.active,
    }));
  } catch (error) {
    console.error("Error fetching Jira users:", error.message);
    throw error;
  }
}

async function getOpenProjectUsers() {
  try {
    let users = [];
    let iter = 1;
    while (true) {
      let response = await openProjectApi.get("/users", { params: { offset: iter++ } });
      let iterationUsers = response.data._embedded.elements;
      users.push(...iterationUsers)

      if (users.length == response.data.total) {
        break;
      }
    }
    
    return users;
  } catch (error) {
    console.error("Error fetching OpenProject users:", error.message);
    throw error;
  }
}

function printHelp() {
  console.log("node create-users.js [--domain domain] [--dry-run] [--create-users]\n" +
    "Make an automated mapping of all Jira Users to OpenProject Users based on their e-mail-addresses.\n\n" +
    "--domain\tOnlyInclude users whose e-mail-address ends witht he given domain (without @)\n" +
    "--create-users\tCreate a fitting OpenProject User if a Jira user with an e-mailcanot be linked.\n" +
    "--dry-run\tprint actions on the console instead of executing them.\n" +
    "--help\t\tPrint this help and exit.\n"
  );
}

async function main() {
    const args = process.argv.slice(2);

    if (args.includes("--help")) {
      printHelp();
      return;
    }

    const domain = args.includes("--domain") ? '@' + args[args.indexOf("--domain") + 1] : "";
    const dryRun = args.includes("--dry-run");
    const createUsers = args.includes("--create-users");

    let jiraUsers = await getJiraUsers();
    jiraUsers = jiraUsers.filter(user =>  user.emailAddress != null && user.emailAddress.endsWith(domain) );
    const jiraUserDict = {};

    let openProjectUserList = await getOpenProjectUsers();

    const openProjectUsers = {};

    for (let user of openProjectUserList) {
        openProjectUsers[user.email] = user.id;
    }

    let created = [];
    let mapping = {};

    // adding mappings and creating users where missing
    for (let user of jiraUsers) {
        if (openProjectUsers[user.emailAddress] !== undefined) {
            console.log(`maping Jira ${user.displayName} (${user.emailAddress}) to OpenProject ${openProjectUsers[user.emailAddress]}`)
            mapping[user.accountId] = openProjectUsers[user.emailAddress];
        } else {
            console.log(`Creating new OpenProjectUser for Jira ${user.displayName} (${user.emailAddress})`)
            let name = user.displayName.split(" ");

            let payload = {
                login: user.emailAddress,
                password: "1234567890",
                lastName: name.pop(),
                firstName: name.join(" "),
                email: user.emailAddress,
                status: "active",
                language: "de"
            }

            if (createUsers) {
              if (dryRun) {
                console.log("\nWould create user:")
                console.log(payload)
                openProjectUsers[user.emailAddress] = "Test_ID";
              } else {
                try {
                  await openProjectApi.post("/users", payload);
                } catch (e) {
                  console.error(`Could not create OpenProject User for ${user.emailAddress}: ` + (e?.data ? e.data : e))
                }
              }
              created.push(user.emailAddress)
            }
        }
    }

    // adding users that have been created 
    if (created.length > 0) {
        openProjectUserList = await getOpenProjectUsers();

        for (let user of openProjectUserList) {
            openProjectUsers[user.email] = user.id;
        }

        

        for (let user of jiraUsers) {
            jiraUserDict[user.emailAddress] = user.accountId;
        }

        for (let user of created) {
            mapping[jiraUserDict[user]] = openProjectUsers[user];
        }
    }
    
    if (dryRun) {
      console.log("Would save user mapping to user-mapping.js:");
      console.log(JSON.stringify(mapping, null, 2));
    } else {
      const mappingContent = `// Generated user mapping - ${new Date().toISOString()}
      const userMapping = ${JSON.stringify(mapping, null, 2)};
      
      module.exports = userMapping;
      `;
      
      fs.writeFileSync(path.join(__dirname, "user-mapping.js"), mappingContent);
      console.log("\nUser mapping has been saved to user-mapping.js");
    }
}

main();
