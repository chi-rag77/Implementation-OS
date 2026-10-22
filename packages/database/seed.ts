import type { PGlite } from "@electric-sql/pglite";
import { DEMO_USER, DEMO_WORKSPACE } from "./local.ts";
export const uid = (n: number) =>
  `10000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const stages = [
  "Kickoff",
  "Discovery",
  "Requirements",
  "Solution design",
  "Configuration",
  "Integration",
  "UAT",
  "Training",
  "Go-live",
];
const taskGroups = [
  [
    "Align implementation outcomes",
    "Confirm project charter",
    "Identify steering committee",
    "Agree communication cadence",
  ],
  [
    "Map current sourcing process",
    "Review procurement policies",
    "Inventory supplier data",
    "Document ERP landscape",
    "Interview category managers",
  ],
  [
    "Confirm approval thresholds",
    "Define supplier qualification rules",
    "Capture RFQ scoring requirements",
    "Agree audit retention policy",
    "Validate reporting requirements",
  ],
  [
    "Approve solution blueprint",
    "Design SAP data mapping",
    "Review authentication architecture",
    "Define exception handling",
    "Sign off workflow design",
  ],
  [
    "Configure sourcing templates",
    "Set up approval workflows",
    "Import supplier master data",
    "Configure user permissions",
    "Set up procurement categories",
    "Validate notification rules",
  ],
  [
    "Connect SAP sandbox",
    "Map cost-center identifiers",
    "Validate supplier sync",
    "Reconcile purchase-order payloads",
    "Test integration retry policy",
    "Review integration security",
  ],
  [
    "Validate multi-currency approval flow",
    "Resolve SAP cost-center mapping",
    "Confirm procurement test scenarios",
    "Execute supplier onboarding UAT",
    "Capture UAT sign-off",
    "Verify audit export",
  ],
  [
    "Prepare buyer training guides",
    "Schedule procurement training",
    "Record supplier onboarding walkthrough",
    "Train workspace administrators",
    "Collect training feedback",
  ],
  [
    "Approve cutover checklist",
    "Verify production credentials",
    "Run go-live readiness review",
    "Confirm hypercare ownership",
    "Publish go-live communication",
  ],
];
export async function seedDemo(db: PGlite) {
  if (
    (
      await db.query("select id from public.workspaces where id=$1", [
        DEMO_WORKSPACE,
      ])
    ).rows.length
  )
    return false;
  await db.transaction(async (tx) => {
    await tx.query(
      "insert into auth.users(id,email,email_confirmed_at) values($1,$2,now()) on conflict do nothing",
      [DEMO_USER, "demo@implementation.local"],
    );
    await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [
      DEMO_USER,
    ]);
    await tx.query(
      "insert into workspaces(id,name,slug,created_by) values($1,'Aerchain','aerchain-demo',$2)",
      [DEMO_WORKSPACE, DEMO_USER],
    );
    await tx.query(
      "insert into workspace_members(workspace_id,user_id,role) values($1,$2,'OWNER')",
      [DEMO_WORKSPACE, DEMO_USER],
    );
    const date = (days: number) =>
      new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    const companies = [
      "Danone",
      "Vesuvius",
      "Acme Corp",
      "Nova Health",
      "Globex Logistics",
    ];
    for (let i = 0; i < companies.length; i++) {
      await tx.query(
        "insert into companies(id,workspace_id,name,industry,metadata) values($1,$2,$3,$4,$5)",
        [
          uid(10 + i),
          DEMO_WORKSPACE,
          companies[i],
          [
            "Food & beverage",
            "Manufacturing",
            "Technology",
            "Healthcare",
            "Logistics",
          ][i],
          JSON.stringify({ demo: true }),
        ],
      );
      await tx.query(
        "insert into implementations(id,workspace_id,company_id,name,description,status,start_date,target_go_live_date,metadata) values($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          uid(100 + i),
          DEMO_WORKSPACE,
          uid(10 + i),
          `${companies[i]} ${i === 0 ? "Autonomous Sourcing" : i === 1 ? "Procurement Transformation" : i === 2 ? "Supplier Onboarding" : i === 3 ? "Purchasing Operations" : "Source-to-Pay"}`,
          "Deploy and validate procurement workflows with customer-owned sign-off.",
          i < 4 ? "ACTIVE" : "PLANNING",
          date(-42 + i * 7),
          date(14 + i * 12),
          JSON.stringify({
            demo: true,
            owner_name: [
              "Chirag S",
              "Priya M",
              "Alex R",
              "Sarah K",
              "Chirag S",
            ][i],
          }),
        ],
      );
    }
    let taskIndex = 0;
    for (let i = 0; i < stages.length; i++) {
      await tx.query(
        "insert into implementation_stages(id,workspace_id,implementation_id,name,key,sequence,status,progress) values($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          uid(200 + i),
          DEMO_WORKSPACE,
          uid(100),
          stages[i],
          stages[i].toLowerCase().replaceAll(" ", "-"),
          i,
          i < 6 ? "COMPLETED" : i === 6 ? "IN_PROGRESS" : "NOT_STARTED",
          i < 6 ? 100 : 0,
        ],
      );
      for (const title of taskGroups[i]) {
        const status =
          i < 6
            ? "COMPLETED"
            : i === 6
              ? taskIndex < 33
                ? "BLOCKED"
                : "IN_PROGRESS"
              : "NOT_STARTED";
        await tx.query(
          "insert into tasks(id,workspace_id,implementation_id,stage_id,title,description,status,priority,due_date,owner_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
          [
            uid(1000 + taskIndex),
            DEMO_WORKSPACE,
            uid(100),
            uid(200 + i),
            title,
            "Confirm the acceptance criteria with the procurement lead and attach sign-off evidence.",
            status,
            status === "BLOCKED" ? "HIGH" : "MEDIUM",
            date(i < 6 ? -10 : i === 6 ? (taskIndex < 33 ? -2 : 2) : 8),
            DEMO_USER,
          ],
        );
        taskIndex++;
      }
    }
    await tx.query(
      "update implementations set current_stage_id=$1 where id=$2",
      [uid(206), uid(100)],
    );
    for (let i = 0; i < 8; i++)
      await tx.query(
        "insert into milestones(id,workspace_id,implementation_id,name,target_date,status,sequence) values($1,$2,$3,$4,$5,$6,$7)",
        [
          uid(300 + i),
          DEMO_WORKSPACE,
          uid(100),
          [
            "Charter approved",
            "Discovery complete",
            "Requirements frozen",
            "Blueprint approved",
            "Configuration ready",
            "Integration verified",
            "UAT signed off",
            "Production go-live",
          ][i],
          date(i < 6 ? -5 : 7 + (i - 6) * 7),
          i < 6 ? "COMPLETED" : "IN_PROGRESS",
          i,
        ],
      );
    for (let i = 0; i < 14; i++)
      await tx.query(
        "insert into task_dependencies(workspace_id,implementation_id,task_id,depends_on_task_id) values($1,$2,$3,$4)",
        [DEMO_WORKSPACE, uid(100), uid(1001 + i), uid(1000 + i)],
      );
    for (let i = 0; i < 6; i++)
      await tx.query(
        "insert into stakeholders(id,workspace_id,implementation_id,name,role,company,type) values($1,$2,$3,$4,$5,$6,$7)",
        [
          uid(400 + i),
          DEMO_WORKSPACE,
          uid(100),
          [
            "Marie Laurent",
            "Thomas Bernard",
            "Sophie Martin",
            "Alex Chen",
            "Priya Menon",
            "Chirag S",
          ][i],
          [
            "Executive sponsor",
            "Procurement lead",
            "IT lead",
            "Integration engineer",
            "Customer success",
            "Implementation owner",
          ][i],
          i < 3 ? "Danone" : "Aerchain",
          i < 3 ? "CUSTOMER" : "INTERNAL",
        ],
      );
    const docs = [
      "Statement of work",
      "Business requirements",
      "Solution blueprint",
      "SAP field mapping",
      "Supplier import template",
      "Security review",
      "Procurement approval matrix",
      "Integration runbook",
      "UAT acceptance criteria",
      "Training handbook",
      "Cutover checklist",
      "Hypercare plan",
    ];
    for (let i = 0; i < 12; i++)
      await tx.query(
        "insert into documents(id,workspace_id,implementation_id,name,type,source) values($1,$2,$3,$4,$5,$6)",
        [
          uid(500 + i),
          DEMO_WORKSPACE,
          uid(100),
          docs[i],
          "REFERENCE",
          "DEMO_METADATA",
        ],
      );
    for (let i = 0; i < 5; i++)
      await tx.query(
        "insert into requirements(id,workspace_id,implementation_id,title,description,status) values($1,$2,$3,$4,$5,$6)",
        [
          uid(600 + i),
          DEMO_WORKSPACE,
          uid(100),
          [
            "Multi-currency approvals",
            "Supplier tax validation",
            "SAP cost-center mapping",
            "Regional access controls",
            "Exportable audit trail",
          ][i],
          "Validated during the procurement discovery workshop.",
          i === 2 ? "CHANGED" : i < 2 ? "VALIDATED" : "CONFIRMED",
        ],
      );
    for (let i = 0; i < 3; i++) {
      await tx.query(
        "insert into meetings(id,workspace_id,implementation_id,title,start_time,summary,transcript_status) values($1,$2,$3,$4,$5,$6,$7)",
        [
          uid(700 + i),
          DEMO_WORKSPACE,
          uid(100),
          [
            "Procurement discovery workshop",
            "Integration review",
            "UAT readiness review",
          ][i],
          `${date(-7 + i * 3)}T09:00:00Z`,
          "Team reviewed acceptance criteria, ownership and the next delivery milestone.",
          "COMPLETED",
        ],
      );
      await tx.query(
        "insert into meeting_transcripts(id,workspace_id,implementation_id,meeting_id,speaker,timestamp_ms,text) values($1,$2,$3,$4,$5,$6,$7)",
        [
          uid(750 + i),
          DEMO_WORKSPACE,
          uid(100),
          uid(700 + i),
          "Thomas Bernard",
          720000 + i * 120000,
          [
            "We need approval thresholds to support EUR and USD.",
            "Cost-center mapping must be validated before procurement testing.",
            "The procurement team needs six signed-off test scenarios before UAT completion.",
          ][i],
        ],
      );
    }
    await tx.query(
      "insert into risks(id,workspace_id,implementation_id,title,description,severity,impact) values($1,$2,$3,'Cost-center mapping needs validation','The SAP mapping is blocking the procurement acceptance test.','HIGH','UAT sign-off depends on finance validation.')",
      [uid(800), DEMO_WORKSPACE, uid(100)],
    );
    await tx.query(
      "insert into risks(id,workspace_id,implementation_id,title,description,severity) values($1,$2,$3,'Training attendance not confirmed','Procurement leads have not confirmed the final training slot.','MEDIUM')",
      [uid(801), DEMO_WORKSPACE, uid(100)],
    );
    const entities = (
      await tx.query<any>(
        "select * from graph_entities where workspace_id=$1",
        [DEMO_WORKSPACE],
      )
    ).rows;
    for (const [source, target, relation] of [
      [uid(751), uid(602), "EXTRACTED_FROM"],
      [uid(602), uid(1032), "SPECIFIES"],
      [uid(1032), uid(800), "CONTRIBUTES_TO"],
    ]) {
      await tx.query(
        "insert into evidence_links(workspace_id,implementation_id,source_entity_id,target_entity_id,relationship,excerpt) values($1,$2,$3,$4,$5,$6)",
        [
          DEMO_WORKSPACE,
          uid(100),
          entities.find((e: any) => e.entity_id === source).id,
          entities.find((e: any) => e.entity_id === target).id,
          relation,
          "Cost-center mapping must be validated before procurement testing.",
        ],
      );
    }
    // Other portfolio records have real seeded tasks, not invented dashboard percentages.
    for (let i = 1; i < 5; i++)
      for (let j = 0; j < 5; j++)
        await tx.query(
          "insert into tasks(workspace_id,implementation_id,title,status,due_date,priority) values($1,$2,$3,$4,$5,$6)",
          [
            DEMO_WORKSPACE,
            uid(100 + i),
            [
              "Confirm project scope",
              "Review supplier data",
              "Configure approval routing",
              "Validate ERP mapping",
              "Approve launch checklist",
            ][j],
            j < i
              ? "COMPLETED"
              : i === 2 && j === 3
                ? "BLOCKED"
                : "IN_PROGRESS",
            date(i === 2 && j === 3 ? -1 : 10 + j),
            "MEDIUM",
          ],
        );
  });
  return true;
}
