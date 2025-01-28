import { groq } from "@ai-sdk/groq";
import { Octokit } from "@octokit/rest";
import { extractReasoningMiddleware, generateText, experimental_wrapLanguageModel as wrapLanguageModel } from "ai";
import { config } from "dotenv";
import readline from 'readline';
import { parseStringPromise } from "xml2js";

config({ path: ".env.local" });

const GITHUB_OWNER = process.env.GITHUB_OWNER || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "";

if (!GITHUB_OWNER || !GITHUB_REPO) {
  throw new Error("GITHUB_OWNER and GITHUB_REPO environment variables must be set");
}

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN
});

const enhancedModel = wrapLanguageModel({
  model: groq("deepseek-r1-distill-llama-70b"),
  middleware: extractReasoningMiddleware({ tagName: "think" })
});

interface FileContent {
  path: string;
  content: string;
}

interface RepoFile {
  path: string;
  content: string;
  sha: string;
}

async function getRepoFiles(path = ""): Promise<RepoFile[]> {
  const files: RepoFile[] = [];

  try {
    const { data: contents } = await octokit.repos.getContent({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      path
    });

    for (const item of Array.isArray(contents) ? contents : [contents]) {
      console.log("Item:", item);
      if (item.type === "file") {
        const { data: blob } = await octokit.git.getBlob({
          owner: GITHUB_OWNER,
          repo: GITHUB_REPO,
          file_sha: item.sha
        });

        files.push({
          path: item.path,
          content: Buffer.from(blob.content, 'base64').toString(),
          sha: item.sha
        });
      } else if (item.type === "dir") {
        files.push(...await getRepoFiles(item.path));
      }
    }
  } catch (error) {
    console.error(`Error reading ${path}:`, error);
  }

  return files;
}

async function getUserRequirements(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(`Describe your feature request or code changes. You can specify:
1. New features/functionality
2. Code modifications
3. Bug fixes
4. Performance improvements
5. Tests/documentation
6. Specific files to modify

Your requirements: `, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function extractXMLFromResponse(text: string): string {
  const xmlStart = text.indexOf("<response>");
  const xmlEnd = text.indexOf("</response>") + "</response>".length;

  if (xmlStart === -1 || xmlEnd === -1) {
    throw new Error("Could not find valid XML in model response");
  }

  return text.slice(xmlStart, xmlEnd);
}

interface PRMetadata {
  title: string;
  body: string;
}

interface GeneratedContent {
  files: FileContent[];
  pr: PRMetadata;
}

async function parseModelResponse(xmlResponse: string): Promise<GeneratedContent> {
  const parsed = await parseStringPromise(xmlResponse);
  return {
    files: parsed.response.files[0].file.map((file: any) => ({
      path: file.path[0],
      content: file.content[0]
    })),
    pr: {
      title: parsed.response.pullRequest[0].title[0],
      body: parsed.response.pullRequest[0].body[0]
    }
  };
}

async function createAutomatedPR() {
  try {
    console.log("Getting repo files...");
    const repoFiles = await getRepoFiles();
    console.log("Repo files:", repoFiles);
    const codebaseContext = repoFiles.map(f => `${f.path}:\n${f.content}`).join('\n\n');
    console.log("Codebase context:", codebaseContext);

    const userRequirements = await getUserRequirements();
    console.log("User requirements:", userRequirements);
    const { text: rawResponse, reasoning } = await generateText({
      model: enhancedModel,
      messages: [
        {
          role: "system",
          content: `You are a TypeScript expert. Analyze the following codebase and generate changes based on user requirements.
Respond ONLY with valid XML in this format:
<response>
  <pullRequest>
    <title>Title of the pull request</title>
    <body>Detailed description of the changes</body>
  </pullRequest>
  <files>
    <file>
      <path>path/to/file</path>
      <content>File content</content>
    </file>
  </files>
</response>

Current codebase:
${codebaseContext}`
        },
        {
          role: "user",
          content: userRequirements
        }
      ]
    });

    const xmlResponse = extractXMLFromResponse(rawResponse);
    const { files, pr } = await parseModelResponse(xmlResponse);

    const { data: repo } = await octokit.repos.get({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO
    });

    const defaultBranch = repo.default_branch;
    const newBranch = `feature/${pr.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`;

    const { data: ref } = await octokit.git.getRef({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      ref: `heads/${defaultBranch}`
    });

    await octokit.git.createRef({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      ref: `refs/heads/${newBranch}`,
      sha: ref.object.sha
    });

    for (const file of files) {
      await octokit.repos.createOrUpdateFileContents({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        path: file.path,
        message: `Update ${file.path}`,
        content: Buffer.from(file.content).toString("base64"),
        branch: newBranch
      });
    }

    const { data: pullRequest } = await octokit.pulls.create({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      title: pr.title,
      body: pr.body,
      head: newBranch,
      base: defaultBranch
    });

    await octokit.issues.createComment({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      issue_number: pullRequest.number,
      body: `## AI Model's Reasoning Process\n\n${reasoning}\n\n## Modified Files\n${files.map(f => `- ${f.path}`).join("\n")}`
    });

    console.log("Pull request created:", pullRequest.html_url);
  } catch (error) {
    console.error("Error creating PR:", error);
    if (error instanceof Error) {
      console.error("Error details:", error.message);
    }
  }
}

if (process.argv.includes('--interactive')) {
  createAutomatedPR();
} else {
  console.log(`
Usage: 
    npm start -- --interactive    Start in interactive mode
  `);
}