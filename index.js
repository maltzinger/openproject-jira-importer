require("dotenv").config();
const fs = require("fs");
const path = require("path");
const inquirer = require("inquirer");
const {
  getAllJiraIssues,
  getSpecificJiraIssues,
  downloadAttachment,
  listProjects,
  getIssueWatchers,
} = require("./jira-client");
const { generateMapping } = require("./generate-user-mapping");
const {
  getOpenProjectWorkPackages,
  createWorkPackage,
  updateWorkPackage,
  addComment,
  addUserToProject,
  uploadAttachment,
  getWorkPackageTypes,
  getWorkPackageStatuses,
  getWorkPackageTypeId,
  getWorkPackageStatusId,
  getExistingAttachments,
  getExistingComments,
  getOpenProjectUsers,
  findExistingWorkPackage,
  JIRA_ID_CUSTOM_FIELD,
  getWorkPackagePriorityId,
  getWorkPackagePriorities,
  addWatcher,
} = require("./openproject-client");

// Create temp directory for attachments if it doesn't exist
const tempDir = path.join(__dirname, "temp");
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

let userMapping = null;

async function getOpenProjectUserId(jiraUser) {
  if (!jiraUser) {
    console.log("No Jira user provided");
    return null;
  }

  const openProjectUserId = userMapping[jiraUser.accountId];
  if (openProjectUserId) {
    console.log(
      `Found OpenProject user ID ${openProjectUserId} for Jira user ${jiraUser.displayName}`
    );
    return openProjectUserId;
  }

  console.log(
    `No OpenProject user mapping found for Jira user ${jiraUser.displayName}`
  );
  return null;
}

function getErrors(e) {
  let errors = [];
  if (e?.response?.data?._type == "Error") {
    if (e.response.data.errorIdentifier == "urn:openproject-org:api:v3:errors:MultipleErrors") {
      for (let subError of e.response.data._embedded.errors) {
        errors.push(...getErrors({ response: { data: subError } }));
      } 
    } else {
      errors.push({ error: e.response.data.errorIdentifier, details: e.response.data._embedded.details });
    }
  }

  return errors;
}

async function migrateIssues(
  jiraProjectKey,
  openProjectId,
  isProd,
  specificIssues,
  skipUpdates,
  mapResponsible
) {
  console.log(
    `Starting migration for project ${jiraProjectKey} to OpenProject project ${openProjectId}`
  );
  console.log("Production mode:", isProd ? "yes" : "no");
  console.log(
    "Map Jira creator to OpenProject accountable:",
    mapResponsible ? "yes" : "no"
  );

  // Generate or load user mapping
  console.log("\nChecking user mapping...");
  try {
    userMapping = require("./user-mapping");
    const shouldUpdate = await inquirer.prompt([
      {
        type: "confirm",
        name: "update",
        message: "Existing user mapping found. Would you like to update it?",
        default: false,
      },
    ]);
    if (shouldUpdate.update) {
      userMapping = await generateMapping();
    }
  } catch (error) {
    console.log("No existing user mapping found. Generating new mapping...");
    userMapping = await generateMapping();
  }

  // List available projects
  await listProjects();

  // Get work package types and statuses
  await getWorkPackageTypes();
  await getWorkPackageStatuses();
  await getWorkPackagePriorities();
  await getOpenProjectUsers();

  // Cache OpenProject work packages if skipUpdates is enabled
  let openProjectWorkPackagesCache = null;
  if (skipUpdates) {
    console.log("Caching OpenProject work packages...");
    openProjectWorkPackagesCache = await getOpenProjectWorkPackages(
      openProjectId
    );
    console.log(
      `Found ${openProjectWorkPackagesCache.size} work packages in OpenProject`
    );
  }

  // Get Jira issues
  const jiraIssues = specificIssues
    ? await getSpecificJiraIssues(jiraProjectKey, specificIssues)
    : await getAllJiraIssues(jiraProjectKey);

  console.log(`Found ${jiraIssues.length} Jira issues to process`);
  console.log("Issues will be processed in chronological order (oldest first)");

  // Process each issue
  let processed = 0;
  let skipped = 0;
  let errors = 0;
  const issueToWorkPackageMap = new Map();

  for (const issue of jiraIssues) {
    try {
      console.log(`\nProcessing ${issue.key}...`);

      // Check if work package already exists
      let existingWorkPackage = null;
      if (skipUpdates) {
        existingWorkPackage = openProjectWorkPackagesCache.get(issue.key);
      } else {
        existingWorkPackage = await findExistingWorkPackage(
          issue.key,
          openProjectId
        );
      }

      if (existingWorkPackage && skipUpdates) {
        console.log(
          `Skipping ${issue.key} - already exists as work package ${existingWorkPackage.id}`
        );
        issueToWorkPackageMap.set(issue.key, existingWorkPackage.id);
        skipped++;
        continue;
      }

      // Get assignee ID from mapping
      let assigneeId = null;
      let responsibleId = null;
      if (issue.fields.assignee) {
        assigneeId = await getOpenProjectUserId(issue.fields.assignee);
      }
      if (mapResponsible && issue.fields.creator) {
        responsibleId = await getOpenProjectUserId(issue.fields.creator);
      }

      // Create work package payload
      const payload = {
        _type: "WorkPackage",
        subject: issue.fields.summary,
        description: {
          raw: Buffer.from(
            convertAtlassianDocumentToText(issue.fields.description)
          ).toString("utf8"),
        },
        _links: {
          type: {
            href: `/api/v3/types/${getWorkPackageTypeId(
              issue.fields.issuetype.name
            )}`,
          },
          status: {
            href: `/api/v3/statuses/${getWorkPackageStatusId(
              issue.fields.status.name
            )}`,
          },
          priority: {
            href: `/api/v3/priorities/${getWorkPackagePriorityId(
              issue.fields.priority
            )}`,
          },
          project: {
            href: `/api/v3/projects/${openProjectId}`,
          },
        },
        [`customField${JIRA_ID_CUSTOM_FIELD}`]: issue.key,
      };

      // Add assignee if available
      if (assigneeId) {
        payload._links.assignee = {
          href: `/api/v3/users/${assigneeId}`,
        };
      }

      // Add responsible (accountable) if available
      if (responsibleId) {
        payload._links.responsible = {
          href: `/api/v3/users/${responsibleId}`,
        };
      }

      let workPackage;
      if (existingWorkPackage) {
        console.log(`Updating existing work package ${existingWorkPackage.id}`);
        workPackage = await updateWorkPackage(existingWorkPackage.id, payload);
      } else {
        console.log("Creating new work package");
        try {
          workPackage = await createWorkPackage(openProjectId, payload);
        } catch (e) {
          // Adding user to project if it's an issue about not being in a project
          let errors = getErrors(e);

          errors = errors.map(error => {
            if (error.error == "urn:openproject-org:api:v3:errors:PropertyConstraintViolation") {
              return error?.details?.attribute;
            }
            return null;
          });

          if (errors.includes("assignee") || errors.includes("responsible")) {
            let toAdd = {};
            toAdd[responsibleId] = true;
            toAdd[assigneeId] = true;
            let ids = Object.keys(toAdd);
            
            console.log(`Adding user${ids.length > 1 ? "s": ""} to project: ${ids.join(", ")}`)
            for (let id of ids) {
              await addUserToProject(id, openProjectId);
            }

            console.log("Re-trying after adding to project...");
            workPackage = await createWorkPackage(openProjectId, payload);
            console.log("success");
          } else {
            // re-throw error otherwise
            throw e;
          }
        }
        
      }

      issueToWorkPackageMap.set(issue.key, workPackage.id);

      // Process attachments
      if (issue.fields.attachment && issue.fields.attachment.length > 0) {
        const existingAttachments = await getExistingAttachments(
          workPackage.id
        );
        const existingAttachmentNames = existingAttachments.map(
          (a) => a.fileName
        );

        for (const attachment of issue.fields.attachment) {
          if (existingAttachmentNames.includes(attachment.filename)) {
            console.log(`Skipping existing attachment: ${attachment.filename}`);
            continue;
          }

          console.log(`Processing attachment: ${attachment.filename}`);
          const tempFilePath = path.join(tempDir, attachment.filename);
          await downloadAttachment(attachment.content, tempFilePath);
          await uploadAttachment(
            workPackage.id,
            tempFilePath,
            attachment.filename
          );
          fs.unlinkSync(tempFilePath);
        }
      }

      // Process comments
      if (issue.fields.comment && issue.fields.comment.comments.length > 0) {
        const existingComments = await getExistingComments(workPackage.id);
        const existingCommentTexts = existingComments.map((c) => c.comment.raw);

        for (const comment of issue.fields.comment.comments) {
          const commentText = convertAtlassianDocumentToText(comment.body);
          if (commentText) {
            const formattedComment = `${
              comment.author.displayName
            } wrote on ${new Date(
              comment.created
            ).toLocaleString()}:\n${commentText}`;

            if (existingCommentTexts.includes(formattedComment)) {
              console.log("Skipping existing comment");
              continue;
            }

            console.log("Adding comment");
            await addComment(workPackage.id, formattedComment);
          }
        }
      }

      // Add watchers if any
      if (issue.fields.watches?.watchCount > 0) {
        console.log("Adding watchers");
        const watchers = await getIssueWatchers(issue.key);
        for (const watcher of watchers.watchers) {
          const watcherId = await getOpenProjectUserId(watcher);
          if (watcherId) {
            try {
              await addWatcher(workPackage.id, watcherId);
            } catch (e) {
              // Adding user to project if it's an issue about not being in a project
              let errors = getErrors(e);

              errors = errors.map(error => {
                if (error.error == "urn:openproject-org:api:v3:errors:PropertyConstraintViolation") {
                  return error?.details?.attribute;
                }
                return null;
              });

              if (errors.includes("user")) {
                console.log(`Adding user ${watcherId} to project ${openProjectId}`)
                await addUserToProject(watcherId, openProjectId);
                console.log("Re-trying after adding user to Project...");
                await addWatcher(workPackage.id, watcherId);
                console.log("success")
              } else {
                // re-throw error otherwise
                throw e;
              }
            }
          }
        }
      }

      processed++;
    } catch (error) {
      console.error(`Error processing ${issue.key}:`, error.message);
      if (error.response?.data) {
        console.error(
          "Error details:",
          JSON.stringify(error.response.data, null, 2)
        );
      }
      errors++;
    }
  }

  // Clean up temp directory
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true });
  }

  console.log("\nMigration summary:");
  console.log(`Total issues processed: ${processed + skipped}`);
  console.log(`Completed: ${processed}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Errors: ${errors}`);

  return issueToWorkPackageMap;
}

function convertAtlassianDocumentToText(document) {
  if (!document) return "";
  if (typeof document === "string") return document;

  try {
    if (document.content) {
      return document.content
        .map((block) => block.content?.map((c) => c.text).join("") || "")
        .join("\n")
        .trim();
    }
    return "";
  } catch (error) {
    console.error("Error converting Atlassian document:", error);
    return "";
  }
}

module.exports = {
  migrateIssues,
};
