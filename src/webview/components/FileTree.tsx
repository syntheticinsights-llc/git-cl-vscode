import type { BoardFile, BoardFolder } from '../../board/protocol';
import { NO_STATUS } from '../../board/protocol';
import { ChevronRightIcon, FileIcon, FolderIcon } from '../icons';
import { StatsBadge } from './StatsBadge';

interface FileTreeProps {
	folder: BoardFolder;
	groupKey: string;
	collapsed: ReadonlySet<string>;
	activeFilePath: string | undefined;
	onToggleFolder: (folderKey: string) => void;
	onOpenFile: (filePath: string) => void;
}

export function FileTree({
	folder,
	groupKey,
	collapsed,
	activeFilePath,
	onToggleFolder,
	onOpenFile,
}: FileTreeProps) {
	return (
		<FolderBranch
			folder={folder}
			groupKey={groupKey}
			ownerPath={folder.path}
			depth={0}
			collapsed={collapsed}
			activeFilePath={activeFilePath}
			onToggleFolder={onToggleFolder}
			onOpenFile={onOpenFile}
		/>
	);
}

interface FolderBranchProps {
	folder: BoardFolder;
	groupKey: string;
	ownerPath: string;
	depth: number;
	collapsed: ReadonlySet<string>;
	activeFilePath: string | undefined;
	onToggleFolder: (folderKey: string) => void;
	onOpenFile: (filePath: string) => void;
}

function FolderBranch({
	folder,
	groupKey,
	ownerPath,
	depth,
	collapsed,
	activeFilePath,
	onToggleFolder,
	onOpenFile,
}: FolderBranchProps) {
	return (
		<>
			{folder.folders.map(child => {
				const childPath = child.path || ownerPath;
				const key = `${groupKey}|${childPath}`;
				const isCollapsed = collapsed.has(key);
				return (
					<div key={key}>
						<div
							className="trow folder"
							style={{ paddingLeft: indent(depth) }}
							title={child.path}
							onClick={() => onToggleFolder(key)}
						>
							<span className={isCollapsed ? 'chev' : 'chev open'}>
								<ChevronRightIcon />
							</span>
							<span className="ico">
								<FolderIcon />
							</span>
							<span className="name">{child.name}</span>
						</div>
						{!isCollapsed && (
							<FolderBranch
								folder={child}
								groupKey={groupKey}
								ownerPath={childPath}
								depth={depth + 1}
								collapsed={collapsed}
								activeFilePath={activeFilePath}
								onToggleFolder={onToggleFolder}
								onOpenFile={onOpenFile}
							/>
						)}
					</div>
				);
			})}
			{folder.files.map(file => (
				<FileRow
					key={file.path}
					file={file}
					depth={depth}
					selected={file.path === activeFilePath}
					onOpenFile={onOpenFile}
				/>
			))}
		</>
	);
}

interface FileRowProps {
	file: BoardFile;
	depth: number;
	selected: boolean;
	onOpenFile: (filePath: string) => void;
}

function FileRow({ file, depth, selected, onOpenFile }: FileRowProps) {
	const hasCounts = (file.additions ?? 0) > 0 || (file.deletions ?? 0) > 0;
	return (
		<div
			className={selected ? 'trow file selected' : 'trow file'}
			style={{ paddingLeft: indent(depth) }}
			title={file.renamedFrom ? `${file.renamedFrom} → ${file.path}` : file.path}
			onClick={() => onOpenFile(file.path)}
		>
			<span className="chev" />
			<span className="ico">
				<FileIcon />
			</span>
			<span className="name">{basename(file.path)}</span>
			{hasCounts ? (
				<StatsBadge additions={file.additions} deletions={file.deletions} />
			) : (
				<span className="status" data-code={file.status}>
					{file.status === NO_STATUS ? '·' : file.status}
				</span>
			)}
		</div>
	);
}

function indent(depth: number): string {
	return `${12 + depth * 8}px`;
}

function basename(filePath: string): string {
	return filePath.slice(filePath.lastIndexOf('/') + 1);
}
